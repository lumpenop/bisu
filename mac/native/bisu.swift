// bisu's shell, in AppKit instead of Electron.
//
// The engine (ui/server.mjs) and the page (ui/index.html) are unchanged: this file only replaces what
// Electron was doing — a status item, a popover under it, the full window, the ⌥Space shortcut, and
// the context handed to the page. That is roughly 430 MB of Chromium replaced by one WebKit view.
//
// It owns exactly the same things the Electron shell owned, so nothing about the assistant changes:
//   • the engine child process, started through dec so bisu never holds the key
//   • a frameless panel the page can drag and resize through the same JS bridge it already used
//   • what the person was looking at (front app, selected text, clipboard), read in-process
//   • the Accessibility permission, now asked for by the app itself rather than by a helper
import Cocoa
import WebKit
import Carbon.HIToolbox
import UserNotifications

// MARK: - small utilities

func bin(_ data: Data) -> String { String(decoding: data, as: UTF8.self) }

let SUPPORT = (FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!)
  .appendingPathComponent("bisu", isDirectory: true)
let LOGS = (FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first!)
  .appendingPathComponent("Logs/bisu", isDirectory: true)
let STATE = SUPPORT.appendingPathComponent("desktop.json")

func ensureDirs() {
  for dir in [SUPPORT, LOGS, SUPPORT.appendingPathComponent("shots")] {
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
                                             attributes: [.posixPermissions: 0o700])
    try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
  }
}

var logHandle: FileHandle?
func log(_ parts: String...) {
  let line = "\(ISO8601DateFormatter().string(from: Date())) \(parts.joined(separator: " "))\n"
  if logHandle == nil {
    try? FileManager.default.createDirectory(at: LOGS, withIntermediateDirectories: true)
    let path = LOGS.appendingPathComponent("bisu.log")
    if !FileManager.default.fileExists(atPath: path.path) {
      FileManager.default.createFile(atPath: path.path, contents: nil)
    }
    logHandle = try? FileHandle(forWritingTo: path)
    logHandle?.seekToEndOfFile()
  }
  logHandle?.write(Data(line.utf8))
}

// The page reads and writes the same desktop.json the Electron shell used, so a person keeps their
// panel position and settings across the change.
func readState() -> [String: Any] {
  guard let data = try? Data(contentsOf: STATE),
        let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
  return j
}

func saveState(_ patch: [String: Any]) {
  var state = readState()
  for (k, v) in patch { state[k] = v }
  guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted]) else { return }
  try? data.write(to: STATE, options: .atomic)
  try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: STATE.path)
}

func randomToken() -> String {
  var bytes = [UInt8](repeating: 0, count: 24)
  _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
  return bytes.map { String(format: "%02x", $0) }.joined()
}

func freePort() -> Int {
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  guard fd >= 0 else { return 0 }
  defer { close(fd) }
  var addr = sockaddr_in()
  addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
  addr.sin_family = sa_family_t(AF_INET)
  addr.sin_port = 0
  addr.sin_addr.s_addr = inet_addr("127.0.0.1")
  let bound = withUnsafePointer(to: &addr) { ptr in
    ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
  }
  guard bound == 0 else { return 0 }
  var out = sockaddr_in()
  var len = socklen_t(MemoryLayout<sockaddr_in>.size)
  let got = withUnsafeMutablePointer(to: &out) { ptr in
    ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
  }
  guard got == 0 else { return 0 }
  return Int(UInt16(bigEndian: out.sin_port))
}

extension String {
  var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

// MARK: - the engine

final class Engine {
  private(set) var process: Process?
  private var stdinPipe: Pipe?
  private(set) var port = 0
  private(set) var ready = false
  let token = randomToken()
  private var logBuffer = ""
  var onExit: (() -> Void)?

  var base: URL { URL(string: "http://127.0.0.1:\(port)")! }

  // Where node usually lives. Finder and Spotlight start an app with almost no PATH, so every
  // known place is checked directly instead of trusting the environment.
  private func nodePath() -> String? {
    let home = FileManager.default.homeDirectoryForCurrentUser
    var candidates: [String] = [
      "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node",
      home.appendingPathComponent(".local/bin/node").path,
      home.appendingPathComponent(".volta/bin/node").path,
      home.appendingPathComponent(".asdf/shims/node").path,
      home.appendingPathComponent(".local/share/mise/shims/node").path,
      home.appendingPathComponent(".grok/bin/node").path,
    ]
    // fnm keeps one directory per shell; the newest is the current version.
    func newest(_ dir: URL, depth: Int = 2) -> String? {
      let fm = FileManager.default
      var best: (Date, String)?
      func walk(_ url: URL, _ level: Int) {
        guard level <= depth, let entries = try? fm.contentsOfDirectory(at: url, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        for e in entries {
          var isDir: ObjCBool = false
          guard fm.fileExists(atPath: e.path, isDirectory: &isDir), isDir.boolValue else { continue }
          let node = e.appendingPathComponent("bin/node")
          if fm.isExecutableFile(atPath: node.path) {
            let date = (try? e.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            if best == nil || date > best!.0 { best = (date, node.path) }
          } else if level < depth {
            walk(e, level + 1)
          }
        }
      }
      walk(dir, 0)
      return best?.1
    }
    if let n = newest(home.appendingPathComponent(".local/state/fnm_multishells"), depth: 2) { candidates.append(n) }
    if let n = newest(home.appendingPathComponent(".nvm/versions/node"), depth: 1) { candidates.append(n) }
    for c in candidates where FileManager.default.isExecutableFile(atPath: c) { return c }
    return nil
  }

  private func decBridge() -> String? {
    let p = SUPPORT.appendingPathComponent("dec/sdk/dec-secret.mjs").path
    return FileManager.default.fileExists(atPath: p) ? p : nil
  }

  // What dec holds (references and sites, never values), so only keys that exist are referenced:
  // a missing one would stop the engine from starting at all, which is worse than running without it.
  private func decList(_ node: String) -> String {
    let bridge = decBridge()
    let shim = "/Users/lumpen/.local/bin/dec-secret"
    var exe = node, args: [String]
    if let b = bridge { args = [b, "list"] } else if FileManager.default.isExecutableFile(atPath: shim) { exe = shim; args = ["list"] } else { return "" }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return "" }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return bin(data)
  }
  private func decHas(_ list: String, _ name: String) -> Bool { list.range(of: "dec://" + name, options: .caseInsensitive) != nil }
  // A key found by the site it is saved for, under whatever name it was given ("텔레그램 봇", say).
  private func decRef(_ list: String, site: String) -> String? {
    for line in list.split(separator: "\n") where line.contains(site) {
      if let ref = line.split(separator: " ").first(where: { $0.hasPrefix("dec://") }) { return String(ref) }
    }
    return nil
  }

  func start(server: URL, root: URL) throws {
    guard let node = nodePath() else {
      throw NSError(domain: "bisu", code: 1, userInfo: [NSLocalizedDescriptionKey: "node was not found (install Node, or run `bisu app install` from Terminal once)"])
    }
    port = freePort()
    guard port > 0 else { throw NSError(domain: "bisu", code: 2, userInfo: [NSLocalizedDescriptionKey: "could not find a free local port"]) }

    var env = ProcessInfo.processInfo.environment
    for k in env.keys where k.hasPrefix("CLAUDE") || k.hasPrefix("ANTHROPIC") { env.removeValue(forKey: k) }
    env["PATH"] = "\((node as NSString).deletingLastPathComponent):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    env["BISU_UI_NO_OPEN"] = "1"
    env["BISU_UI_PARENT"] = "stdin"
    env["BISU_UI_PORT"] = String(port)
    env["BISU_UI_TOKEN"] = token
    env.removeValue(forKey: "OPENAI_API_KEY")
    env.removeValue(forKey: "OPENAI_BASE_URL")

    let p = Process()
    if let bridge = decBridge() {
      p.executableURL = URL(fileURLWithPath: node)
      p.arguments = [bridge, "run", "--", node, server.path]
      env["OPENROUTER_API_KEY"] = "dec://OPENROUTER_API_KEY"
      let list = decList(node)
      if decHas(list, "OPENAI_API_KEY") { env["OPENAI_API_KEY"] = "dec://OPENAI_API_KEY" }
      // bisu's own engine thinks with Z.ai GLM; the key is passed the same use-only way.
      if decHas(list, "GLM_API_KEY") { env["GLM_API_KEY"] = "dec://GLM_API_KEY" }
      // Telegram: the bot token saved in dec for api.telegram.org, whatever its name. Read at every
      // engine start, so Settings' "bisu 다시 켜기" picks up a token saved a moment ago.
      if let ref = decRef(list, site: "https://api.telegram.org") { env["TELEGRAM_BOT_TOKEN"] = ref }
      // Every key saved for the model sites, for the engine's key order (engine/routes.mjs, the order being dec's
      // model-routes.json): BISU_RK<n>_API_KEY each, listed in BISU_ROUTE_KEYS as "n|name|site".
      var routeKeys: [String] = []
      for line in list.split(separator: "\n") {
        let cols = line.split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
        guard cols.count >= 2, cols[0].hasPrefix("dec://"), !cols[0].hasPrefix("dec://env/"), routeKeys.count < 12,
              ["https://openrouter.ai", "https://api.z.ai", "https://api.openai.com"].contains(cols[1]) else { continue }
        let n = routeKeys.count + 1
        env["BISU_RK\(n)_API_KEY"] = cols[0]
        routeKeys.append("\(n)|\(cols[0].dropFirst(6))|\(cols[1])")
      }
      if !routeKeys.isEmpty { env["BISU_ROUTE_KEYS"] = routeKeys.joined(separator: ";") }
    } else if let key = env["OPENROUTER_API_KEY"], !key.isEmpty {
      p.executableURL = URL(fileURLWithPath: node)
      p.arguments = [server.path]
    } else {
      throw NSError(domain: "bisu", code: 3, userInfo: [NSLocalizedDescriptionKey: "dec-secret is missing: run `bisu app install` in Terminal once so bisu has a readable copy of it."])
    }
    p.environment = env
    p.currentDirectoryURL = root

    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    // Held open for the shell's lifetime: when bisu quits or crashes, the engine sees EOF and stops
    // instead of being left running on its own.
    stdinPipe = Pipe()
    p.standardInput = stdinPipe
    pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      guard !d.isEmpty else { return }
      let text = bin(d)
      self?.logBuffer = String(((self?.logBuffer ?? "") + text).suffix(4000))
      for line in text.split(separator: "\n") where !line.isEmpty { log("engine:", String(line).trimmed) }
    }
    p.terminationHandler = { [weak self] _ in
      self?.ready = false
      self?.process = nil
      self?.onExit?()
    }
    try p.run()
    process = p
    log("engine started on port \(port) via \(p.arguments?.first ?? "")")
  }

  func stop() {
    process?.terminate()
    process = nil
    ready = false
  }

  // The engine answers only with the token, so this doubles as the token check.
  func waitReady(timeout: TimeInterval = 30) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if !(process?.isRunning ?? false) { return false }
      if syncGet("/") != nil { ready = true; return true }
      Thread.sleep(forTimeInterval: 0.25)
    }
    return false
  }

  private func syncGet(_ path: String) -> Data? {
    var req = URLRequest(url: base.appendingPathComponent(path))
    req.timeoutInterval = 2
    req.setValue(token, forHTTPHeaderField: "X-Bisu-Token")
    var result: Data?
    let sem = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { data, resp, _ in
      if let http = resp as? HTTPURLResponse, http.statusCode == 200 { result = data }
      sem.signal()
    }.resume()
    _ = sem.wait(timeout: .now() + 3)
    return result
  }

  func getJSON(_ path: String, query: [String: String] = [:], done: @escaping ([String: Any]?) -> Void) {
    var url = base.appendingPathComponent(path)
    if !query.isEmpty, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) {
      parts.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
      url = parts.url ?? url
    }
    var req = URLRequest(url: url)
    req.timeoutInterval = 8
    req.setValue(token, forHTTPHeaderField: "X-Bisu-Token")
    URLSession.shared.dataTask(with: req) { data, _, _ in
      let j = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      DispatchQueue.main.async { done(j) }
    }.resume()
  }

  func post(_ path: String, body: [String: Any] = [:], done: @escaping ([String: Any]?) -> Void = { _ in }) {
    var req = URLRequest(url: base.appendingPathComponent(path))
    req.httpMethod = "POST"
    req.timeoutInterval = 20
    req.setValue(token, forHTTPHeaderField: "X-Bisu-Token")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    URLSession.shared.dataTask(with: req) { data, _, _ in
      let j = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      DispatchQueue.main.async { done(j) }
    }.resume()
  }
}

infix operator |>: AdditionPrecedence
func |> <A, B>(_ value: A, _ f: (A) -> B) -> B { f(value) }

// MARK: - context
// MARK: - context

enum Context {
  static func frontApp() -> String? {
    NSWorkspace.shared.frontmostApplication?.localizedName
  }

  // AXSelectedText of whatever has focus, read in-process. This needs the Accessibility permission,
  // and simply reports nothing without it.
  static func selection() -> (String?, String?) {
    let system = AXUIElementCreateSystemWide()
    var focused: CFTypeRef?
    guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
          let element = focused, CFGetTypeID(element) == AXUIElementGetTypeID() else {
      return (nil, AXIsProcessTrusted() ? "nothing was selected" : "needs Accessibility consent")
    }
    var value: CFTypeRef?
    let el = element as! AXUIElement
    guard AXUIElementCopyAttributeValue(el, kAXSelectedTextAttribute as CFString, &value) == .success,
          let text = value as? String else {
      return (nil, "nothing was selected")
    }
    return (text.trimmed.isEmpty ? nil : text, text.trimmed.isEmpty ? "nothing was selected" : nil)
  }

  static func clipboard(_ limit: Int = 6000) -> String? {
    guard let s = NSPasteboard.general.string(forType: .string) else { return nil }
    let t = s.trimmed
    guard !t.isEmpty else { return nil }
    return t.count > limit ? String(t.prefix(limit)) : s
  }

  static func capture(withSelection: Bool, selfName: String = "덱 인턴") -> [String: Any] {
    let app = frontApp()
    // Its own window under either name: the display name, or the bundle name an older build had.
    let own = app?.caseInsensitiveCompare(selfName) == .orderedSame || app?.caseInsensitiveCompare("bisu") == .orderedSame
    let clip = clipboard()
    var sel: (String?, String?) = (nil, nil)
    if withSelection && !own { sel = selection() }
    var out: [String: Any] = ["at": Int(Date().timeIntervalSince1970 * 1000)]
    if !own, let a = app { out["app"] = a }
    if let s = sel.0 { out["selection"] = s.count > 6000 ? String(s.prefix(6000)) : s }
    if let c = clip, c != sel.0 { out["clipboard"] = c }
    if let note = sel.1 { out["note"] = note }
    return out
  }
}

// MARK: - the bridge

final class Bridge: NSObject, WKScriptMessageHandler {
  weak var shell: Shell?

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
    let args = body["args"] as? [String: Any] ?? [:]
    let id = args["__id"] as? Int
    // Replies go back to the page that asked — the panel and the full window are separate views.
    shell?.handle(cmd: cmd, args: args, id: id, from: message.webView)
  }
}

// The page expects window.bisuHost, which Electron's preload used to provide. Same shape, so
// index.html does not know the shell changed.
let shimJS = """
(function(){
  if (window.bisuHost) return;
  const pending = new Map();
  let seq = 0;
  const post = (cmd, args) => window.webkit.messageHandlers.bisu.postMessage({cmd, args: args || {}});
  const call = (cmd, args) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, {res, rej});
    post(cmd, Object.assign({__id: id}, args || {}));
  });
  const subs = {context: new Set(), shown: new Set(), hidden: new Set(), open: new Set(), view: new Set(), teach: new Set()};
  const host = {
    panel: true,
    platform: 'darwin',
    context: () => call('context'),
    consume: () => call('consume'),
    session: (sessionId, cwd) => post('session', {sessionId, cwd}),
    hide: () => post('hide'),
    openFull: view => post('full', {view: view || ''}),
    openPane: pane => post('openPane', {pane}),
    quit: () => post('quit'),
    resize: (width, height) => call('resize', {width, height}),
    bounds: () => call('bounds'),
    pickFolder: () => call('pickFolder'),
    move: (x, y) => post('move', {x, y}),
    panelPlace: (place, reset) => call('panelPlace', {place: place || '', reset: !!reset}),
    iconOpens: value => call('iconOpens', {value: value || ''}),
    shortcuts: () => call('shortcuts'),
    shortcutRecord: id => call('shortcutRecord', {id: id || ''}),
    shortcutReset: id => call('shortcutReset', {id}),
    teachStart: () => call('teachStart'),
    teachStop: () => call('teachStop'),
    teachState: () => call('teachState'),
    onTeach: fn => { subs.teach.add(fn); return () => subs.teach.delete(fn) },
    endMove: () => post('endMove'),
    accessibility: () => call('accessibility'),
    grantAccessibility: () => post('axGrant'),
    dismissAccessibility: () => post('axDismiss'),
    accessibilityHintShown: () => post('axShown'),
    selectionEnabled: () => call('selectionEnabled'),
    setSelectionEnabled: on => call('selectionSet', {on: !!on}),
    onContext: fn => { subs.context.add(fn); return () => subs.context.delete(fn) },
    suggest: n => post('suggest', {n: n || 0}),
    onShown: fn => { subs.shown.add(fn); return () => subs.shown.delete(fn) },
    onHidden: fn => { subs.hidden.add(fn); return () => subs.hidden.delete(fn) },
    notifications: () => call('notifyStatus'),
    requestNotifications: () => call('notifyRequest'),
    openNotificationSettings: () => post('notifySettings'),
    onOpen: fn => { subs.open.add(fn); return () => subs.open.delete(fn) },
    onView: fn => { subs.view.add(fn); return () => subs.view.delete(fn) },
    __reply: (id, ok, value) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      ok ? p.res(value) : p.rej(new Error(typeof value === 'string' ? value : 'failed'));
    },
    __emit: (name, value) => { for (const fn of subs[name] || []) { try { fn(value) } catch (e) {} } },
  };
  window.bisuHost = host;

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) { e.preventDefault(); post('hide') }
  }, true);

  // Dragging: the page marks its grab areas with -webkit-app-region, which WebKit ignores, so the
  // shell moves the window here — the panel, or the full window the page is in. Pointer capture keeps
  // the drag alive past the window edge. In the full window the headers and the strip along the top
  // (where a title bar would be) move it too, and double-clicking there zooms it like a title bar.
  let drag = null;
  const DRAG = '.dragbar, .chathead, #panelStart .startWrap > .bisu, #panelStart .startTitle, #panelStart .ccStatus';
  const FULL = '.chathead, .listHead, .side .brand, .hero';
  const skip = 'button, input, textarea, select, a, label, summary, .grip, [contenteditable]';
  const full = () => !document.body.classList.contains('panel');
  const grab = e => {
    const t = e.target;
    if (!t.closest || t.closest(skip)) return null;
    return t.closest(DRAG) || (full() && (t.closest(FULL) || (e.clientY < 38 ? document.body : null)));
  };
  document.addEventListener('dblclick', e => { if (full() && grab(e)) post('zoom') }, true);
  document.addEventListener('pointerdown', async e => {
    if (e.button !== 0 || e.detail > 1) return;
    const area = grab(e);
    if (!area) return;
    const b = await host.bounds().catch(() => null);
    if (!b) return;
    drag = {sx: e.screenX, sy: e.screenY, x: b.x, y: b.y, id: e.pointerId, el: area};
    try { area.setPointerCapture(e.pointerId) } catch (err) {}
  }, true);
  document.addEventListener('pointermove', e => {
    if (!drag) return;
    // Screen coordinates grow downward in the page and upward in AppKit, hence the minus.
    host.move(drag.x + (e.screenX - drag.sx), drag.y - (e.screenY - drag.sy));
  }, true);
  const endDrag = () => { if (!drag) return; drag = null; host.endMove() };
  document.addEventListener('pointerup', endDrag, true);
  document.addEventListener('pointercancel', endDrag, true);
})();
"""

// WebKit drops alert()/confirm() unless a delegate answers them, which would make a failed request
// look like a button that does nothing. Confirmations did show a real dialog before, so they still do.
final class Dialogs: NSObject, WKUIDelegate {
  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    log("page alert:", message)
    let alert = NSAlert()
    alert.messageText = "덱 인턴"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
    completionHandler()
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = "덱 인턴"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    completionHandler(alert.runModal() == .alertFirstButtonReturn)
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
               defaultText: String?, initiatedByFrame frame: WKFrameInfo,
               completionHandler: @escaping (String?) -> Void) {
    completionHandler(nil)
  }
}

// MARK: - the shell

// MARK: - shortcuts

/// A key combination as macOS menus show it (⌃⌥⇧⌘, then the key). `code` is the key's virtual code, which the
/// global key needs; `key` is the character a menu item needs.
struct Combo: Equatable {
  var code: UInt16
  var mods: NSEvent.ModifierFlags
  var key: String

  private static func fn(_ v: Int) -> String { String(Character(UnicodeScalar(UInt32(v))!)) }
  /// Keys that are not a character, with the name a menu gives them.
  static let special: [UInt16: (key: String, label: String)] = {
    var m: [UInt16: (key: String, label: String)] = [
      49: (" ", "Space"), 36: ("\r", "↩"), 48: ("\t", "⇥"), 51: ("\u{8}", "⌫"), 117: ("\u{7f}", "⌦"), 53: ("\u{1b}", "⎋"),
      123: (fn(NSLeftArrowFunctionKey), "←"), 124: (fn(NSRightArrowFunctionKey), "→"),
      125: (fn(NSDownArrowFunctionKey), "↓"), 126: (fn(NSUpArrowFunctionKey), "↑"),
    ]
    for (i, code) in [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111].enumerated() {
      m[UInt16(code)] = (fn(NSF1FunctionKey + i), "F\(i + 1)")
    }
    return m
  }()
  /// The US layout, for a key whose character the current layout does not give as plain ASCII.
  private static let us: [UInt16: String] = [0: "a", 1: "s", 2: "d", 3: "f", 4: "h", 5: "g", 6: "z", 7: "x", 8: "c", 9: "v", 11: "b",
    12: "q", 13: "w", 14: "e", 15: "r", 16: "y", 17: "t", 18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 24: "=", 25: "9",
    26: "7", 27: "-", 28: "8", 29: "0", 30: "]", 31: "o", 32: "u", 33: "[", 34: "i", 35: "p", 37: "l", 38: "j", 39: "'", 40: "k",
    41: ";", 42: "\\", 43: ",", 44: "/", 45: "n", 46: "m", 47: ".", 50: "`"]

  init(code: UInt16, mods: NSEvent.ModifierFlags, key: String) {
    self.code = code
    self.mods = mods.intersection([.command, .option, .control, .shift])
    self.key = key
  }

  /// The combination a key press makes; nil for a key a menu cannot show.
  init?(event e: NSEvent) {
    if let s = Combo.special[e.keyCode] { self.init(code: e.keyCode, mods: e.modifierFlags, key: s.key); return }
    let typed = e.characters(byApplyingModifiers: [])?.lowercased() ?? ""
    let plain = typed.count == 1 && typed.unicodeScalars.allSatisfy { $0.value > 0x20 && $0.value < 0x7f }
    guard let key = plain ? typed : Combo.us[e.keyCode] else { return nil }
    self.init(code: e.keyCode, mods: e.modifierFlags, key: key)
  }

  init?(json j: [String: Any]) {
    guard let code = j["code"] as? Int, let mods = j["mods"] as? Int, let key = j["key"] as? String, !key.isEmpty else { return nil }
    self.init(code: UInt16(code), mods: NSEvent.ModifierFlags(rawValue: UInt(mods)), key: key)
  }

  var json: [String: Any] { ["code": Int(code), "mods": Int(mods.rawValue), "key": key] }

  var label: String {
    var s = ""
    if mods.contains(.control) { s += "⌃" }
    if mods.contains(.option) { s += "⌥" }
    if mods.contains(.shift) { s += "⇧" }
    if mods.contains(.command) { s += "⌘" }
    return s + (Combo.special[code]?.label ?? key.uppercased())
  }

  var carbonMods: UInt32 {
    (mods.contains(.command) ? UInt32(cmdKey) : 0) | (mods.contains(.option) ? UInt32(optionKey) : 0)
      | (mods.contains(.control) ? UInt32(controlKey) : 0) | (mods.contains(.shift) ? UInt32(shiftKey) : 0)
  }

  /// Typing stays typing: a shortcut has ⌘, ⌃ or ⌥, unless it is a function key.
  var usable: Bool { !mods.isDisjoint(with: [.command, .option, .control]) || Combo.special[code]?.label.hasPrefix("F") == true }

  static func == (a: Combo, b: Combo) -> Bool { a.code == b.code && a.mods == b.mods }
}

/// 설정 → 단축키. The defaults are the keys bisu always had; desktop.json keeps only what someone changed
/// ("shortcuts": {id: combo, or {} for none}). 창 닫기 and 종료 can be changed too; text editing, hide and minimize
/// keep the system's keys.
enum Shortcuts {
  struct Command { let id: String; let label: String; let def: Combo?; let global: Bool }
  static let commands = [
    Command(id: "talk", label: "덱 인턴 부르기 (어느 앱에서나)", def: Combo(code: 49, mods: .option, key: " "), global: true),
    Command(id: "settings", label: "설정…", def: Combo(code: 43, mods: .command, key: ","), global: false),
    Command(id: "full", label: "전체 창 열기", def: Combo(code: 31, mods: .command, key: "o"), global: false),
    Command(id: "suggest", label: "지금 제안 받기", def: nil, global: false),
    Command(id: "close", label: "창 닫기", def: Combo(code: 13, mods: .command, key: "w"), global: false),
    Command(id: "quit", label: "덱 인턴 종료", def: Combo(code: 12, mods: .command, key: "q"), global: false),
  ]
  static let fixed: [(Combo, String)] = [
    (Combo(code: 4, mods: .command, key: "h"), "가리기"),
    (Combo(code: 4, mods: [.command, .option], key: "h"), "기타 가리기"), (Combo(code: 6, mods: .command, key: "z"), "실행 취소"),
    (Combo(code: 6, mods: [.command, .shift], key: "z"), "실행 복귀"), (Combo(code: 7, mods: .command, key: "x"), "오려두기"),
    (Combo(code: 8, mods: .command, key: "c"), "복사하기"), (Combo(code: 9, mods: .command, key: "v"), "붙여넣기"),
    (Combo(code: 9, mods: [.command, .option, .shift], key: "v"), "붙여넣기 및 스타일 일치"), (Combo(code: 0, mods: .command, key: "a"), "모두 선택"),
    (Combo(code: 46, mods: .command, key: "m"), "최소화"),
  ]

  static func saved() -> [String: Any] { readState()["shortcuts"] as? [String: Any] ?? [:] }

  static func combo(_ id: String) -> Combo? {
    if let v = saved()[id] as? [String: Any] { return Combo(json: v) }
    return commands.first { $0.id == id }?.def
  }

  /// Who already has these keys, other than `id` itself.
  static func owner(of c: Combo, except id: String) -> String? {
    if let f = fixed.first(where: { $0.0 == c }) { return f.1 }
    return commands.first { $0.id != id && combo($0.id) == c }?.label
  }

  static func set(_ id: String, _ c: Combo?) {
    var s = saved()
    if c == commands.first(where: { $0.id == id })?.def { s.removeValue(forKey: id) } else { s[id] = c?.json ?? [String: Any]() }
    saveState(["shortcuts": s])
  }

  static func reset(_ id: String) {
    var s = saved()
    if id == "all" { s = [:] } else { s.removeValue(forKey: id) }
    saveState(["shortcuts": s])
  }

  static func rows() -> [[String: Any]] {
    commands.map { ["id": $0.id, "label": $0.label, "keys": combo($0.id)?.label ?? "", "changed": saved()[$0.id] != nil, "global": $0.global] }
  }
}

extension NSMenuItem {
  /// Shows (and answers to) `combo`, or no keys.
  func keys(_ combo: Combo?) -> NSMenuItem {
    keyEquivalent = combo?.key ?? ""
    keyEquivalentModifierMask = combo?.mods ?? []
    return self
  }
}

final class Shell: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate, WKNavigationDelegate, UNUserNotificationCenterDelegate {
  private var statusItem: NSStatusItem!
  /// The screen the full window should open on ("settings" from the menu or the panel); empty for the last one.
  private var fullView = ""
  /// 보여 주고 가르치기: records only between the page's 시작 and 멈추기.
  let recorder = Recorder()
  private var panel: Panel!
  private var web: WKWebView!
  private var container: NSView!
  private var fullWindow: NSWindow?
  private var engine: Engine!
  private var bridge: Bridge!
  private let dialogs = Dialogs()
  private var hotKey: EventHotKeyRef?
  private var pendingContext: [String: Any]?
  private var activeChatId: String?
  private var spend: String?
  private var suggestUnread = 0
  private var lastHidden = Date.distantPast
  private var showCount = 0
  private var axMenuItem: NSMenuItem?

  private var shortcutLabel: String { Shortcuts.combo("talk")?.label ?? "단축키 없음" }
  /// 설정 → 단축키 while a row waits for its keys: the key watcher, the page's answer, and the 15-second limit.
  private var keyMonitor: Any?
  private var keyReply: ((Any?) -> Void)?
  private var keyTimer: Timer?
  private var quitting = false
  /// What the chats are doing, for the menu bar icon: "" (nothing), "working", or "waiting" (an
  /// approval nobody has answered). Polled from the engine, because the panel's page stops
  /// listening when it hides — which is exactly when the icon matters.
  private var chatState = ""
  private var stateTimer: Timer?
  /// The engine's notices already shown: ids restart with each engine, which `noticeBoot` tells apart.
  private var noticeBoot: String?
  private var noticeLast = 0
  private var engineRestarts: [Date] = []
  private let minW: CGFloat = 380
  private let minH: CGFloat = 320

  // MARK: lifecycle

  func applicationDidFinishLaunching(_ notification: Notification) {
    ensureDirs()
    log("bisu (native) starting")
    engine = Engine()
    // terminationHandler runs on a background queue; everything it leads to touches AppKit.
    engine.onExit = { [weak self] in DispatchQueue.main.async { self?.engineExited() } }
    buildStatusItem()
    buildMainMenu()
    buildPanel()
    registerHotKey()
    setUpNotifications()
    startEngineThenLoad()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationWillTerminate(_ notification: Notification) {
    quitting = true
    engine?.stop()
    if let h = hotKey { UnregisterEventHotKey(h) }
  }

  // MARK: status item

  private func trayImage(badged: Bool = false, ring: Bool = false) -> NSImage? {
    let base: NSImage
    if let dir = Bundle.main.resourceURL?.appendingPathComponent("app/mac/assets"),
       let found = ["trayTemplate@2x", "trayTemplate"].lazy.compactMap({ NSImage(contentsOf: dir.appendingPathComponent("\($0).png")) }).first {
      found.size = NSSize(width: 18, height: 18)
      base = found
    } else {
      // A drawn fallback so the item is never invisible.
      let img = NSImage(size: NSSize(width: 18, height: 18))
      img.lockFocus()
      NSColor.black.setStroke()
      let path = NSBezierPath(ovalIn: NSRect(x: 2, y: 2, width: 14, height: 14))
      path.lineWidth = 2
      path.stroke()
      img.unlockFocus()
      base = img
    }
    base.isTemplate = true
    if badged { return dot(on: base) }
    if ring { return dot(on: base, hollow: true) }
    return base
  }

  /// The icon with a dot in the corner it leaves empty, for a suggestion nobody has answered yet.
  /// Drawn at 2x so it stays crisp in the menu bar; the dot is punched out of the icon first so the
  /// two never merge into one blob.
  private func dot(on base: NSImage, hollow: Bool = false) -> NSImage {
    let size = NSSize(width: 18, height: 18), scale: CGFloat = 2
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale),
                                     pixelsHigh: Int(size.height * scale), bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return base }
    rep.size = size
    let out = NSImage(size: size)
    out.addRepresentation(rep)
    out.lockFocus()
    base.draw(in: NSRect(origin: .zero, size: size))
    let center = NSPoint(x: size.width - 3.2, y: 3.2)
    if let ctx = NSGraphicsContext.current {
      ctx.compositingOperation = .clear
      NSBezierPath(ovalIn: NSRect(x: center.x - 3.6, y: center.y - 3.6, width: 7.2, height: 7.2)).fill()
      ctx.compositingOperation = .sourceOver
    }
    let mark = NSBezierPath(ovalIn: NSRect(x: center.x - 2.3, y: center.y - 2.3, width: 4.6, height: 4.6))
    if hollow {
      // Working: a ring, so "busy" never reads as "needs you".
      NSColor.black.setStroke()
      mark.lineWidth = 1.3
      mark.stroke()
    } else {
      NSColor.black.setFill()
      mark.fill()
    }
    out.unlockFocus()
    out.isTemplate = true
    return out
  }

  private func setSuggest(_ n: Int) {
    // The page reports this on every poll; only a change is worth redrawing the icon for.
    let v = max(0, n)
    guard v != suggestUnread else { return }
    suggestUnread = v
    refreshTray()
    log("suggestions waiting:", String(v))
  }

  /// One place decides the icon: a filled dot when something needs the person (an approval, or a
  /// card nobody has read), a ring while bisu is working, nothing when it is idle.
  private func refreshTray() {
    guard let button = statusItem?.button else { return }
    let needsYou = chatState == "waiting" || suggestUnread > 0
    button.image = trayImage(badged: needsYou, ring: !needsYou && chatState == "working")
    button.image?.isTemplate = true
    var tip = "덱 인턴"
    if chatState == "waiting" { tip += " · 확인이 필요해요" }
    else if chatState == "working" { tip += " · 일하는 중" }
    if suggestUnread > 0 { tip += " · 새 카드 \(suggestUnread)개" }
    button.toolTip = "\(tip) · \(shortcutLabel)"
  }

  private func pollChats() {
    guard engine?.ready == true else { return }
    pollNotices()
    engine.getJSON("api/chats") { [weak self] j in
      guard let self else { return }
      let chats = j?["chats"] as? [[String: Any]] ?? []
      let waiting = chats.contains { ($0["pending"] as? Int ?? 0) > 0 }
      let working = chats.contains { ($0["busy"] as? Bool ?? false) || ($0["tasks"] as? Int ?? 0) > 0 }
      let next = waiting ? "waiting" : working ? "working" : ""
      guard next != self.chatState else { return }
      self.chatState = next
      self.refreshTray()
      log("chats:", next.isEmpty ? "idle" : next)
    }
  }

  // MARK: notifications

  /// macOS asks once whether bisu may show notifications; after that the answer lives in System
  /// Settings, which Settings in the page links to.
  private func setUpNotifications() {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    center.getNotificationSettings { s in
      guard s.authorizationStatus == .notDetermined else { return }
      center.requestAuthorization(options: [.alert, .sound]) { ok, error in
        log("notifications:", ok ? "allowed" : "not allowed", error?.localizedDescription ?? "")
      }
    }
  }

  private func notificationStatus(_ done: @escaping (String) -> Void) {
    UNUserNotificationCenter.current().getNotificationSettings { s in
      let name: String
      switch s.authorizationStatus {
      case .authorized: name = "authorized"
      case .provisional: name = "provisional"
      case .denied: name = "denied"
      case .notDetermined: name = "notDetermined"
      default: name = "unknown"
      }
      DispatchQueue.main.async { done(name) }
    }
  }

  /// Whether the person can already see bisu: then a banner about a conversation is noise.
  private var bisuOnScreen: Bool {
    NSApp.isActive && (panel.isVisible || fullWindow?.isVisible == true)
  }

  private func pollNotices() {
    engine.getJSON("api/notices", query: ["after": String(noticeLast)]) { [weak self] j in
      guard let self, let j else { return }
      let boot = j["boot"] as? String ?? ""
      let last = j["last"] as? Int ?? 0
      // First look: whatever was there before the shell came up is old news.
      guard let known = self.noticeBoot else { self.noticeBoot = boot; self.noticeLast = last; return }
      // A new engine counts from 1 again; the next poll asks from there.
      guard known == boot else { self.noticeBoot = boot; self.noticeLast = 0; return }
      for n in j["notices"] as? [[String: Any]] ?? [] { self.showNotice(n, boot: boot) }
      self.noticeLast = max(self.noticeLast, last)
    }
  }

  private func showNotice(_ n: [String: Any], boot: String) {
    let kind = n["kind"] as? String ?? ""
    let chat = n["chat"] as? String
    if ["approval", "reply", "card"].contains(kind) && bisuOnScreen { return }
    let content = UNMutableNotificationContent()
    content.title = n["title"] as? String ?? "덱 인턴"
    content.body = n["body"] as? String ?? ""
    if kind == "approval" || kind == "event" { content.sound = .default }
    if let chat { content.userInfo = ["chat": chat]; content.threadIdentifier = chat } else { content.threadIdentifier = kind }
    let id = "bisu-\(boot)-\(n["id"] as? Int ?? 0)"
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
      if let error { log("notification failed:", error.localizedDescription) }
    }
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                              withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .list, .sound])
  }

  /// A banner clicked: the window they use comes up on the conversation it was about.
  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                              withCompletionHandler completionHandler: @escaping () -> Void) {
    let chat = (response.notification.request.content.userInfo["chat"] as? String).flatMap {
      $0.range(of: "^[0-9a-f-]{36}$", options: .regularExpression) != nil ? $0 : nil }
    DispatchQueue.main.async {
      var target: WKWebView? = self.web
      if let w = self.fullWindow, w.isVisible, let view = w.contentView as? WKWebView {
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        target = view
      } else {
        self.showPanel()
      }
      if let chat {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
          target?.evaluateJavaScript("window.bisuHost.__emit('open', '\(chat)')", completionHandler: nil)
        }
      }
    }
    completionHandler()
  }

  private func buildStatusItem() {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let button = statusItem.button {
      button.image = trayImage()
      button.image?.isTemplate = true
      button.toolTip = "bisu · \(shortcutLabel)"
      button.target = self
      button.action = #selector(statusClicked(_:))
      button.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }
  }

  @objc private func statusClicked(_ sender: Any?) {
    let event = NSApp.currentEvent
    if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true {
      // Right click opens the menu; left click toggles the panel. Assigning `menu` would swallow the
      // left click, so the menu is shown explicitly.
      statusItem.menu = statusMenu()
      statusItem.button?.performClick(nil)
      statusItem.menu = nil
      return
    }
    // With the full window open, the icon can bring that forward instead (설정 → 패널); the panel is the default.
    if readState()["iconOpens"] as? String == "full", let w = fullWindow, w.isVisible, !panel.isVisible {
      openFull()
      return
    }
    togglePanel()
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    // Nothing: the menu is rebuilt in statusMenu() so state (Accessibility, spend) is current.
  }

  /// Laid out like Control Center: who and how bisu is, the one thing to do, the switches, then open,
  /// settings and quit. Rebuilt on every click so the switches and the spend are current.
  private func statusMenu() -> NSMenu {
    let menu = NSMenu()
    if recorder.recording {
      let rec = NSMenuItem(title: "● 기록 중 — 멈추기 (\(recorder.steps.count)단계)", action: #selector(stopTeachFromMenu), keyEquivalent: "")
      rec.target = self
      menu.addItem(rec)
      menu.addItem(.separator())
    }
    let state = NSMenuItem(title: "덱 인턴 · " + (engine == nil ? "엔진 꺼짐" : "듣고 있어요") + (spend.map { " · 오늘 \($0)" } ?? ""), action: nil, keyEquivalent: "")
    state.isEnabled = false
    menu.addItem(state)
    if spend == nil {
      engine?.getJSON("api/account") { [weak self] j in
        guard let self,
              let key = j?["key"] as? [String: Any],
              let daily = key["usage_daily"] as? Double else { return }
        self.spend = String(format: "$%.2f", daily)
      }
    }
    menu.addItem(.separator())

    let show = NSMenuItem(title: panel?.isVisible == true ? "덱 인턴 숨기기" : "덱 인턴에게 말하기", action: #selector(toggleFromMenu), keyEquivalent: "")
      .keys(Shortcuts.combo("talk"))
    show.target = self
    menu.addItem(show)
    menu.addItem(.separator())

    let selection = NSMenuItem(title: "선택한 텍스트 읽기", action: #selector(toggleSelection), keyEquivalent: "")
    selection.target = self
    selection.state = (readState()["selection"] as? Bool == false) ? .off : .on
    menu.addItem(selection)
    if !AXIsProcessTrusted() {
      let ax = NSMenuItem(title: "손쉬운 사용 허용…", action: #selector(grantAccessibility), keyEquivalent: "")
      ax.target = self
      menu.addItem(ax)
    }
    let ask = NSMenuItem(title: "지금 제안 받기", action: #selector(askForSuggestion), keyEquivalent: "")
      .keys(Shortcuts.combo("suggest"))
    ask.target = self
    menu.addItem(ask)
    menu.addItem(.separator())

    let full = NSMenuItem(title: "전체 창 열기", action: #selector(openFullFromMenu), keyEquivalent: "")
      .keys(Shortcuts.combo("full"))
    full.target = self
    menu.addItem(full)
    let settings = NSMenuItem(title: "설정…", action: #selector(openSettingsFromMenu), keyEquivalent: "")
      .keys(Shortcuts.combo("settings"))
    settings.target = self
    menu.addItem(settings)
    let quit = NSMenuItem(title: "덱 인턴 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
      .keys(Shortcuts.combo("quit"))
    menu.addItem(quit)
    return menu
  }

  @objc private func toggleFromMenu() { togglePanel() }
  @objc private func openFullFromMenu() { openFull() }
  @objc private func openSettingsFromMenu() { openFull(view: "settings") }

  /// While 보여 주고 가르치기 records, the menu bar says so in red and every open page shows its 기록 중 bar.
  func watchRecorder() {
    recorder.onChange = { [weak self] in
      guard let self else { return }
      let rec = self.recorder.recording
      if let b = self.statusItem?.button {
        if rec { b.attributedTitle = NSAttributedString(string: " ● 기록 중", attributes: [.foregroundColor: NSColor.systemRed, .font: NSFont.menuBarFont(ofSize: 0)]) }
        else { b.title = "" }
      }
      self.emitTeach(stop: false)
    }
  }
  private func emitTeach(stop: Bool) {
    let js = "window.bisuHost.__emit('teach', {recording: \(recorder.recording), steps: \(recorder.steps.count), stop: \(stop)})"
    web?.evaluateJavaScript(js, completionHandler: nil)
    if !stop { (fullWindow?.contentView as? WKWebView)?.evaluateJavaScript(js, completionHandler: nil) }
  }
  /// 멈추기 from the menu: the panel finishes it (it sends the steps and opens the draft).
  @objc private func stopTeachFromMenu() {
    showPanel()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.emitTeach(stop: true) }
  }

  /// The one action a suggestion needs from the shell: ask for one now. The page shows it on its next
  /// poll, so the panel is opened here — asking and seeing nothing would look broken.
  @objc private func askForSuggestion() {
    showPanel()
    engine?.post("api/proactive/run") { _ in }
  }

  @objc private func toggleSelection() {
    let on = !(readState()["selection"] as? Bool == false)
    saveState(["selection": on])
  }

  @objc func grantAccessibility() {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    if !AXIsProcessTrusted() {
      NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }
  }

  // MARK: hot key

  private func registerHotKey() {
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let selfPtr = Unmanaged.passUnretained(self).toOpaque()
    InstallEventHandler(GetApplicationEventTarget(), { _, _, userData -> OSStatus in
      guard let userData else { return noErr }
      let shell = Unmanaged<Shell>.fromOpaque(userData).takeUnretainedValue()
      DispatchQueue.main.async { shell.togglePanel() }
      return noErr
    }, 1, &spec, selfPtr, nil)

    applyHotKey()
  }

  /// Registers the global key from 설정 → 단축키 (⌥Space unless changed), or `combo` to try another one.
  /// False when it could not be registered, which is usually another app holding the same keys.
  @discardableResult
  private func applyHotKey(_ combo: Combo? = Shortcuts.combo("talk")) -> Bool {
    if let h = hotKey { UnregisterEventHotKey(h); hotKey = nil }
    guard let combo else { return true }
    let hotKeyID = EventHotKeyID(signature: OSType(0x62697375), id: 1) // 'bisu'
    let status = RegisterEventHotKey(UInt32(combo.code), combo.carbonMods, hotKeyID,
                                    GetApplicationEventTarget(), 0, &hotKey)
    if status != noErr {
      log("hot key could not be registered (\(status))")
      statusItem?.button?.toolTip = "bisu · \(combo.label) is taken by another app"
      return false
    }
    return true
  }

  // MARK: panel

  private func buildPanel() {
    let saved = readState()["panel"] as? [String: Any]
    let width = CGFloat(saved?["width"] as? Double ?? 420)
    let height = CGFloat(saved?["height"] as? Double ?? 600)
    panel = Panel(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                  styleMask: [.borderless, .nonactivatingPanel],
                  backing: .buffered, defer: false)
    panel.isFloatingPanel = true
    panel.level = .statusBar
    panel.hidesOnDeactivate = false
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.isMovable = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
    panel.delegate = self

    bridge = Bridge()
    bridge.shell = self
    let config = WKWebViewConfiguration()
    config.userContentController.add(bridge, name: "bisu")
    config.userContentController.addUserScript(WKUserScript(source: shimJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    config.websiteDataStore = .default()

    // WebKit renders into its own layers, so the rounded corner goes on a container around the web
    // view: setting a corner radius on the WKWebView itself hides its content on macOS.
    // The panel's content rect is not laid out yet at this point (it can be zero), so the container
    // is sized from the frame explicitly; autoresizing keeps it matching when the panel resizes.
    let container = NSView(frame: NSRect(origin: .zero, size: panel.frame.size))
    container.wantsLayer = true
    container.layer?.cornerRadius = 14
    container.layer?.masksToBounds = true
    container.autoresizingMask = [.width, .height]

    web = WKWebView(frame: container.bounds, configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = dialogs
    web.autoresizingMask = [.width, .height]
    container.addSubview(web)
    panel.contentView = container
    self.container = container

    NotificationCenter.default.addObserver(self, selector: #selector(panelResignedKey),
                                          name: NSWindow.didResignKeyNotification, object: panel)
  }

  @objc private func panelResignedKey() {
    // The same behaviour as before: clicking away puts the popover away. A short delay keeps the
    // click that opened the full window from closing the panel first.
    guard panel?.isVisible == true else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
      guard let self, let p = self.panel, p.isVisible, !p.isKeyWindow, self.fullWindow == nil else { return }
      self.hidePanel()
    }
  }

  private func fullURL() -> URL {
    var comps = URLComponents(url: engine.base, resolvingAgainstBaseURL: false)!
    comps.path = "/"
    var items = [URLQueryItem(name: "token", value: engine.token)]
    if let id = activeChatId { items.append(URLQueryItem(name: "chat", value: id)) }
    if !fullView.isEmpty { items.append(URLQueryItem(name: "view", value: fullView)) }
    comps.queryItems = items
    return comps.url!
  }

  private func panelURL() -> URL {
    var comps = URLComponents(url: engine.base, resolvingAgainstBaseURL: false)!
    comps.path = "/"
    var items = [URLQueryItem(name: "panel", value: "1"), URLQueryItem(name: "token", value: engine.token)]
    if let id = activeChatId { items.append(URLQueryItem(name: "chat", value: id)) }
    comps.queryItems = items
    return comps.url!
  }

/// Where the panel opens. 「메뉴바 아래」 (the default and what 위치 초기화 goes back to) puts it under the
  /// icon; 「마지막으로 옮긴 곳」 opens it where it was last dragged on this display, pulled back inside the
  /// screen if that spot no longer fits, and under the icon on a display it was never dragged on.
  private func positionPanel() {
    let state = readState()
    let size = panel.frame.size
    if state["panelPlace"] as? String == "free" {
      let mouse = NSEvent.mouseLocation
      let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? statusItem?.button?.window?.screen ?? NSScreen.main ?? NSScreen.screens[0]
      if let spot = (state["panelSpots"] as? [String: Any])?[screenKey(screen)] as? [String: Any],
         let x = spot["x"] as? Double, let y = spot["y"] as? Double {
        let pt = clampToScreen(NSPoint(x: x, y: y), size: size)
        panel.setFrame(NSRect(x: pt.x, y: pt.y, width: size.width, height: size.height), display: true)
        return
      }
    }
    positionUnderStatusItem()
  }

  private func positionUnderStatusItem() {
    guard let button = statusItem?.button else { return }
    let screen = button.window?.screen ?? NSScreen.main ?? NSScreen.screens[0]
    let area = screen.visibleFrame
    let size = panel.frame.size
    var x = area.maxX - size.width - 12
    var y = area.maxY - size.height - 8
    if button.window != nil {
      let buttonFrame = button.convert(button.bounds, to: nil)
      let screenFrame = button.window!.convertToScreen(buttonFrame)
      x = screenFrame.midX - size.width / 2
      y = screenFrame.minY - size.height - 6
    }
    x = max(area.minX + 8, min(x, area.maxX - size.width - 8))
    y = max(area.minY + 8, min(y, area.maxY - size.height - 8))
    panel.setFrame(NSRect(x: x, y: y, width: size.width, height: size.height), display: true)
  }

  /// A display, the same one across restarts and replugging: vendor, model and serial of its panel.
  private func screenKey(_ screen: NSScreen) -> String {
    guard let n = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return "main" }
    let id = CGDirectDisplayID(n.uint32Value)
    return "\(CGDisplayVendorNumber(id))-\(CGDisplayModelNumber(id))-\(CGDisplaySerialNumber(id))"
  }

  private func clampToScreen(_ origin: NSPoint, size: NSSize) -> NSPoint {
    let probe = NSPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
    let screen = NSScreen.screens.first { $0.frame.contains(probe) } ?? NSScreen.main ?? NSScreen.screens[0]
    let area = screen.visibleFrame
    return NSPoint(x: max(area.minX + 4, min(origin.x, area.maxX - size.width - 4)),
                   y: max(area.minY + 4, min(origin.y, area.maxY - size.height - 4)))
  }

  func togglePanel() {
    if panel.isVisible && panel.isKeyWindow { hidePanel() } else { showPanel() }
  }

  func showPanel() {
    if web.url == nil { loadPanel() }
    positionPanel()
    captureContextSoon()
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
    web.evaluateJavaScript("window.bisuHost.__emit('shown')", completionHandler: nil)
    log("panel shown", "web:", NSStringFromRect(web.frame), "hidden:", String(web.isHidden),
        "inWindow:", String(web.window != nil), "panel:", NSStringFromRect(panel.frame))
    showCount += 1
    let n = showCount
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.debugSnapshot(tag: "show\(n)") }
  }

  /// Lets a build check what the web view actually paints: the window server can hand back a frame
  /// without the accelerated layers in it, so a working page can look empty from a screen capture.
  private func debugSnapshot(tag: String) {
    guard let base = ProcessInfo.processInfo.environment["BISU_SNAPSHOT"] else { return }
    web.takeSnapshot(with: nil) { image, error in
      guard let image, let tiff = image.tiffRepresentation,
            let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
        log("snapshot failed:", error?.localizedDescription ?? "no image")
        return
      }
      let path = base.replacingOccurrences(of: ".png", with: "-\(tag).png")
      try? png.write(to: URL(fileURLWithPath: path))
      log("snapshot:", path, "\(png.count) bytes")
    }
  }

  func hidePanel() {
    guard panel.isVisible else { return }
    lastHidden = Date()
    // The page drops its event stream here, which lets the engine stop Claude Code instead of
    // holding a few hundred megabytes for a panel nobody is looking at.
    web.evaluateJavaScript("window.bisuHost.__emit('hidden')", completionHandler: nil)
    panel.orderOut(nil)
    log("panel hidden")
  }

  private func captureContextSoon() {
    let wantSelection = readState()["selection"] as? Bool != false
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let ctx = Context.capture(withSelection: wantSelection)
      DispatchQueue.main.async {
        guard let self else { return }
        self.pendingContext = ctx
        if let data = try? JSONSerialization.data(withJSONObject: ctx), let json = String(data: data, encoding: .utf8) {
          self.web.evaluateJavaScript("window.bisuHost.__emit('context', \(json))", completionHandler: nil)
        }
      }
    }
  }

  // MARK: loading

  /// The engine is every chat at once, and the page is useless without it: when it exits on its own,
  /// start it again (a little later each time) and reload whatever is showing. Four exits within two
  /// minutes means it is not going to stay up, and saying so beats a restart loop.
  private func engineExited() {
    log("engine exited")
    web?.evaluateJavaScript("window.bisuHost.__emit('engineDown')", completionHandler: nil)
    guard !quitting else { return }
    engineRestarts = engineRestarts.filter { $0.timeIntervalSinceNow > -120 }
    if engineRestarts.count >= 4 {
      showFatal("the engine stopped \(engineRestarts.count) times in two minutes. The log is in ~/Library/Logs/bisu/bisu.log; quit bisu and open it again once it is fixed.")
      return
    }
    engineRestarts.append(Date())
    let delay = 1.5 * Double(engineRestarts.count)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self, !self.quitting, !(self.engine.process?.isRunning ?? false) else { return }
      log("restarting engine (\(self.engineRestarts.count) in the last two minutes)")
      self.startEngineThenLoad()
    }
  }

  private func startEngineThenLoad() {
    guard let resources = Bundle.main.resourceURL else { return }
    let root = resources.appendingPathComponent("app")
    let server = root.appendingPathComponent("ui/server.mjs")
    do {
      try engine.start(server: server, root: root)
    } catch {
      log("engine failed:", error.localizedDescription)
      showFatal(error.localizedDescription)
      return
    }
    DispatchQueue.global().async { [weak self] in
      guard let self else { return }
      if !self.engine.waitReady() {
        DispatchQueue.main.async { self.showFatal("the engine did not answer on port \(self.engine.port)") }
        return
      }
      DispatchQueue.main.async {
        log("engine ready")
        if self.stateTimer == nil {
          self.stateTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.pollChats() }
        }
        self.loadPanel()
        // After a restart the port is new, so an open full window has to follow it.
        if let view = self.fullWindow?.contentView as? WKWebView { view.load(URLRequest(url: self.fullURL())) }
        // The engine may already have something waiting from a run that happened while bisu was
        // closed, so the dot has to be right before any page has had a chance to report it.
        self.engine.getJSON("api/proactive") { j in
          if let waiting = j?["waiting"] as? Int { self.setSuggest(waiting) }
        }
        if ProcessInfo.processInfo.environment["BISU_OPEN_FULL"] == "1" { self.openFull() }
      }
    }
  }

  private func loadPanel() {
    guard engine.ready, engine.port > 0 else { return }
    let url = panelURL()
    log("loading", url.absoluteString.replacingOccurrences(of: engine.token, with: "<token>"))
    web.load(URLRequest(url: url))
  }

  private func showFatal(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "bisu could not start"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
  }

  // MARK: full window

  func openFull(view: String = "") {
    if let w = fullWindow {
      // Screen names are plain words ("settings"); anything else is ignored rather than quoted into script.
      if !view.isEmpty, view.allSatisfy({ $0.isASCII && $0.isLetter }), let web = w.contentView as? WKWebView {
        web.evaluateJavaScript("window.bisuHost.__emit('view', '\(view)')", completionHandler: nil)
      }
      w.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }
    fullView = view
    hidePanel()
    let bridge = Bridge()
    bridge.shell = self
    let config = WKWebViewConfiguration()
    config.userContentController.add(bridge, name: "bisu")
    config.userContentController.addUserScript(WKUserScript(source: shimJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    config.websiteDataStore = .default()
    let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 1080, height: 760), configuration: config)
    view.autoresizingMask = [.width, .height]
    view.navigationDelegate = self
    view.uiDelegate = dialogs

    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1080, height: 760),
                     styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                     backing: .buffered, defer: false)
    w.title = "덱 인턴"
    w.titleVisibility = .hidden
    w.titlebarAppearsTransparent = true
    w.minSize = NSSize(width: 780, height: 520)
    w.contentView = view
    w.center()
    w.isReleasedWhenClosed = false
    w.delegate = self
    fullWindow = w

    view.load(URLRequest(url: fullURL()))
    fullView = ""
    w.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func windowWillClose(_ notification: Notification) {
    if (notification.object as? NSWindow) === fullWindow { fullWindow = nil }
  }

  // MARK: navigation

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // A blank page here would look like a working shell with nothing in it, which is the hardest
    // kind of failure to notice from the outside.
    webView.evaluateJavaScript("(document.body ? document.body.innerText : '').slice(0, 300).replace(/\\n/g, ' / ')") { value, error in
      let which = webView === self.web ? "panel" : "full"
      log("page loaded (\(which)):", (value as? String) ?? "?", error.map { "error: \($0.localizedDescription)" } ?? "")
    }
    if ProcessInfo.processInfo.environment["BISU_DEBUG_DOM"] == "1" {
      let probe = """
      JSON.stringify({
        inputs: [...document.querySelectorAll('input,textarea')].map(e => (e.id || e.className) + ':' + (e.placeholder || '')),
        rects: ['cwd','input','sendBtn','newChat'].map(id => {
          const e = document.getElementById(id);
          if (!e) return id + ':none';
          const r = e.getBoundingClientRect();
          return id + ':' + Math.round(r.x) + ',' + Math.round(r.y) + ',' + Math.round(r.width) + 'x' + Math.round(r.height);
        }),
        body: document.body.className,
      })
      """
      webView.evaluateJavaScript(probe) { value, _ in log("dom:", (value as? String) ?? "?") }
    }
    // Proves the bridge the page talks to actually answers, without needing a mouse: every command
    // goes out and its result comes back through the same path the page uses.
    if ProcessInfo.processInfo.environment["BISU_DEBUG_BRIDGE"] == "1" {
      let test = """
      const out = {panel: window.bisuHost.panel, platform: window.bisuHost.platform};
      out.bounds = await window.bisuHost.bounds();
      out.accessibility = await window.bisuHost.accessibility();
      out.selectionEnabled = await window.bisuHost.selectionEnabled();
      out.context = await window.bisuHost.context();
      await window.bisuHost.resize(430, 610);
      out.afterResize = await window.bisuHost.bounds();
      return JSON.stringify(out);
      """
      webView.callAsyncJavaScript(test, arguments: [:], in: nil, in: .page) { result in
        switch result {
        case .success(let value): log("bridge:", (value as? String) ?? "?")
        case .failure(let error): log("bridge failed:", error.localizedDescription)
        }
      }
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    log("page failed:", error.localizedDescription)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    log("page failed (provisional):", error.localizedDescription)
  }

  // MARK: app menu and 설정 → 단축키

  /// The app's own menu. bisu shows no menu bar (it is an accessory app), but macOS still sends a window's key
  /// equivalents through it: without 편집 the panel's text box ignored ⌘C ⌘V ⌘A ⌘Z. Changes in 설정 → 단축키
  /// rebuild it.
  func buildMainMenu() {
    func item(_ title: String, _ action: Selector, _ key: String, _ mods: NSEvent.ModifierFlags = .command,
              target: AnyObject? = nil) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      i.target = target
      return i
    }
    func mine(_ title: String, _ action: Selector, _ id: String, target: AnyObject? = nil) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: "").keys(Shortcuts.combo(id))
      i.target = target ?? self
      return i
    }
    func top(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
      let menu = NSMenu(title: title)
      items.forEach(menu.addItem)
      let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      i.submenu = menu
      return i
    }
    let main = NSMenu()
    main.addItem(top("덱 인턴", [
      mine("설정…", #selector(openSettingsFromMenu), "settings"),
      mine("전체 창 열기", #selector(openFullFromMenu), "full"),
      mine("지금 제안 받기", #selector(askForSuggestion), "suggest"),
      .separator(),
      item("덱 인턴 가리기", #selector(NSApplication.hide(_:)), "h"),
      item("기타 가리기", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      .separator(),
      mine("덱 인턴 종료", #selector(NSApplication.terminate(_:)), "quit", target: NSApp),
    ]))
    main.addItem(top("편집", [
      item("실행 취소", Selector(("undo:")), "z"),
      item("실행 복귀", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("오려두기", #selector(NSText.cut(_:)), "x"),
      item("복사하기", #selector(NSText.copy(_:)), "c"),
      item("붙여넣기", #selector(NSText.paste(_:)), "v"),
      item("붙여넣기 및 스타일 일치", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
      item("모두 선택", #selector(NSText.selectAll(_:)), "a"),
    ]))
    main.addItem(top("윈도우", [
      item("최소화", #selector(NSWindow.performMiniaturize(_:)), "m"),
      mine("닫기", #selector(closeKeyWindow), "close"),
    ]))
    NSApp.mainMenu = main
  }

  /// ⌘W: the panel hides (it has no close button); any other window closes.
  @objc private func closeKeyWindow() {
    guard let w = NSApp.keyWindow else { return }
    if w === panel { hidePanel() } else { w.performClose(nil) }
  }

  private func shortcutRows(_ message: String = "") -> [String: Any] { ["rows": Shortcuts.rows(), "message": message] }

  /// Waits for the next key press and makes it `id`'s keys, answering the page when it comes, after 15 seconds, or
  /// when cancelled. The press is caught here, not in the page, so ⌘O is recorded instead of opening the window;
  /// the global key is let go meanwhile so pressing it records it instead of hiding the panel.
  private func recordShortcut(_ id: String, reply: @escaping (Any?) -> Void) {
    endRecording("")
    guard let command = Shortcuts.commands.first(where: { $0.id == id }) else { reply(shortcutRows()); return }
    keyReply = reply
    if let h = hotKey { UnregisterEventHotKey(h); hotKey = nil }
    keyTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] _ in self?.endRecording("") }
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
      guard let self else { return e }
      let bare = e.modifierFlags.isDisjoint(with: [.command, .option, .control, .shift])
      if bare && e.keyCode == 53 { self.endRecording(""); return nil }
      if bare && (e.keyCode == 51 || e.keyCode == 117) {
        Shortcuts.set(id, nil)
        self.endRecording("「\(command.label)」 단축키를 없앴어요.")
        return nil
      }
      guard let c = Combo(event: e) else { return nil }
      if !c.usable { self.endRecording("⌘·⌃·⌥ 중 하나와 함께 눌러 주세요."); return nil }
      if let by = Shortcuts.owner(of: c, except: id) { self.endRecording("\(c.label)는 「\(by)」에서 쓰고 있어요."); return nil }
      if command.global && !self.applyHotKey(c) { self.endRecording("\(c.label)는 다른 앱이 이미 쓰고 있어요."); return nil }
      Shortcuts.set(id, c)
      self.endRecording("「\(command.label)」 → \(c.label)")
      return nil
    }
  }

  private func endRecording(_ message: String) {
    guard keyMonitor != nil || keyReply != nil else { return }
    if let m = keyMonitor { NSEvent.removeMonitor(m); keyMonitor = nil }
    keyTimer?.invalidate()
    keyTimer = nil
    applyHotKey()
    buildMainMenu()
    refreshTray()
    let reply = keyReply
    keyReply = nil
    reply?(shortcutRows(message))
  }

  /// `bisu --shortcut-test`: the menu answers ⌘C ⌘V ⌘A ⌘Z … with the standard actions, keys are named the way
  /// menus name them, and taken keys are refused. Reads desktop.json; writes nothing.
  func shortcutSelfTest() -> Bool {
    buildMainMenu()
    var ok = true
    func check(_ good: Bool, _ what: String) { if !good { ok = false; print("FAIL", what) } }
    let items = NSApp.mainMenu?.items.flatMap { $0.submenu?.items ?? [] } ?? []
    func has(_ key: String, _ mods: NSEvent.ModifierFlags, _ action: String) -> Bool {
      items.contains { $0.keyEquivalent == key && $0.keyEquivalentModifierMask == mods && $0.action.map(NSStringFromSelector) == action }
    }
    for (key, action) in [("c", "copy:"), ("v", "paste:"), ("x", "cut:"), ("a", "selectAll:"), ("z", "undo:"),
                          ("h", "hide:"), ("m", "performMiniaturize:")] {
      check(has(key, .command, action), "⌘\(key.uppercased()) → \(action)")
    }
    // 창 닫기 and 종료 answer to whatever 설정 → 단축키 gave them (⌘W and ⌘Q unless changed).
    for (id, action) in [("close", "closeKeyWindow"), ("quit", "terminate:")] {
      let c = Shortcuts.combo(id)
      check(c.map { has($0.key, $0.mods, action) } ?? !items.contains { $0.action.map(NSStringFromSelector) == action && !$0.keyEquivalent.isEmpty },
            "\(id) → \(action)")
    }
    check(Shortcuts.commands.first { $0.id == "quit" }?.def?.label == "⌘Q" && Shortcuts.commands.first { $0.id == "close" }?.def?.label == "⌘W",
          "창 닫기 ⌘W and 종료 ⌘Q by default")
    check(Shortcuts.owner(of: Combo(code: 46, mods: .command, key: "m"), except: "quit") == "최소화", "⌘M stays 최소화")
    check(has("z", [.command, .shift], "redo:"), "⇧⌘Z → redo:")
    let press = { (code: UInt16, chars: String, mods: NSEvent.ModifierFlags) in
      Combo(event: NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: 0, windowNumber: 0, context: nil,
                                    characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!)
    }
    check(press(17, "t", [.command, .shift])?.label == "⇧⌘T", "⇧⌘T")
    check(press(49, " ", .option)?.label == "⌥Space", "⌥Space")
    check(press(33, "[", [.command, .control])?.label == "⌃⌘[", "⌃⌘[")
    check(press(122, "", .command)?.label == "⌘F1", "⌘F1")
    check(press(17, "t", .shift)?.usable == false && press(122, "", [])?.usable == true, "⌘⌃⌥ or a function key")
    check(Shortcuts.owner(of: Combo(code: 8, mods: .command, key: "c"), except: "full") == "복사하기", "⌘C is taken")
    let defs = Shortcuts.commands.compactMap(\.def)
    check(Set(defs.map { "\($0.code)/\($0.mods.rawValue)" }).count == defs.count && !defs.contains { d in Shortcuts.fixed.contains { $0.0 == d } },
          "defaults are distinct")
    print(ok ? "shortcut test passed" : "shortcut test failed")
    return ok
  }

  // MARK: bridge commands

  func handle(cmd: String, args: [String: Any], id: Int?, from view: WKWebView? = nil) {
    let target = view ?? web
    let reply: (Any?) -> Void = { [weak self] value in
      guard let id else { return }
      self?.respond(id: id, value: value, on: target)
    }

    switch cmd {
    case "context":
      reply(pendingContext ?? Context.capture(withSelection: readState()["selection"] as? Bool != false))
    case "consume":
      pendingContext = nil
      reply(nil)
    case "session":
      if let s = args["sessionId"] as? String, s.count == 36 {
        activeChatId = nil
        saveState(["sessionId": s, "cwd": (args["cwd"] as? String) ?? (readState()["cwd"] as? String) ?? ""])
      }
      reply(nil)
    case "hide":
      hidePanel()
    case "full":
      openFull(view: (args["view"] as? String) ?? "")
    case "openPane":
      // Privacy panes the page may send someone to, after asking. Nothing else is reachable from here.
      let panes = ["calendars": "Privacy_Calendars", "reminders": "Privacy_Reminders", "accessibility": "Privacy_Accessibility",
                   "automation": "Privacy_Automation", "screen": "Privacy_ScreenCapture", "input": "Privacy_ListenEvent"]
      if let anchor = panes[(args["pane"] as? String) ?? ""] {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?\(anchor)")!)
      }
    case "quit":
      NSApp.terminate(nil)
    case "resize":
      guard let w = args["width"] as? Double, let h = args["height"] as? Double else { return reply(nil) }
      let f = panel.frame
      let size = NSSize(width: max(minW, CGFloat(w)), height: max(minH, CGFloat(h)))
      // Anchored at the top left, which is where the grip is dragged from.
      let top = f.maxY
      let rect = NSRect(x: f.minX, y: top - size.height, width: size.width, height: size.height)
      panel.setFrame(rect, display: true)
      // Resizing is not moving: only the size is kept. (It used to mark the panel as moved, which pinned a
      // panel resized while hidden to the bottom-left corner of the screen.)
      saveState(["panel": ["width": rect.width, "height": rect.height]])
      reply(["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height])
    case "bounds":
      let f = (view?.window ?? panel).frame
      reply(["x": f.minX, "y": f.minY, "width": f.width, "height": f.height])
    case "pickFolder":
      // A folder the person picks is one macOS has already let them into, which also saves a
      // typed path from hitting a Files-and-Folders prompt on the first message.
      let open = NSOpenPanel()
      open.canChooseFiles = false
      open.canChooseDirectories = true
      open.allowsMultipleSelection = false
      open.canCreateDirectories = true
      open.prompt = "Use this folder"
      open.message = "bisu works in the folder you pick."
      let answer: (NSApplication.ModalResponse) -> Void = { response in
        reply(response == .OK ? open.url?.path : nil)
      }
      if let window = view?.window ?? panel, window.isVisible {
        open.beginSheetModal(for: window, completionHandler: answer)
      } else {
        answer(open.runModal())
      }
    case "move":
      guard let x = args["x"] as? Double, let y = args["y"] as? Double else { return }
      let win = view?.window ?? panel!
      win.setFrameOrigin(clampToScreen(NSPoint(x: x, y: y), size: win.frame.size))
    case "zoom":
      if let w = view?.window, w !== panel { w.zoom(nil) }
    case "endMove":
      // Only the panel remembers where it was put; the full window is an ordinary window.
      guard view?.window == nil || view?.window === panel else { return }
      let f = panel.frame
      let probe = NSPoint(x: f.midX, y: f.midY)
      let screen = NSScreen.screens.first { $0.frame.contains(probe) } ?? panel.screen ?? NSScreen.main ?? NSScreen.screens[0]
      var spots = readState()["panelSpots"] as? [String: Any] ?? [:]
      spots[screenKey(screen)] = ["x": f.minX, "y": f.minY]
      saveState(["panelSpots": spots, "panelPlace": "free"])
    case "teachStart":
      // Asked at the press: the page shows 「설정하러 가시겠어요?」 for whichever permission is missing.
      if !AXIsProcessTrusted() { reply(["ok": false, "need": "accessibility"]); return }
      if !Recorder.inputAllowed { CGRequestListenEventAccess(); reply(["ok": false, "need": "input"]); return }
      watchRecorder()
      let ok = recorder.start()
      reply(ok ? ["ok": true] : ["ok": false, "need": "input"])
    case "teachStop":
      reply(["steps": recorder.stop()])
    case "teachState":
      reply(["recording": recorder.recording, "steps": recorder.steps.count])
    case "iconOpens":
      if let v = args["value"] as? String, v == "panel" || v == "full" { saveState(["iconOpens": v]) }
      reply(readState()["iconOpens"] as? String ?? "panel")
    case "panelPlace":
      // 메뉴바 아래 or 마지막으로 옮긴 곳; reset forgets every display's spot and goes back under the icon.
      var patch: [String: Any] = [:]
      if args["reset"] as? Bool == true { patch["panelSpots"] = [String: Any](); patch["panelPlace"] = "menubar" }
      else if let place = args["place"] as? String, place == "menubar" || place == "free" { patch["panelPlace"] = place }
      if !patch.isEmpty { saveState(patch); if panel.isVisible { positionPanel() } }
      let st = readState()
      reply(["place": st["panelPlace"] as? String ?? "menubar", "spots": (st["panelSpots"] as? [String: Any])?.count ?? 0])
    case "accessibility":
      reply([
        "trusted": AXIsProcessTrusted(),
        "enabled": readState()["selection"] as? Bool != false,
        "dismissed": readState()["axDismissed"] as? Bool == true,
        "shown": readState()["axHintShown"] as? Bool == true,
      ])
    case "axGrant":
      grantAccessibility()
    case "axDismiss":
      saveState(["axDismissed": true, "axHintShown": true])
    case "axShown":
      saveState(["axHintShown": true])
    case "selectionEnabled":
      reply(readState()["selection"] as? Bool != false)
    case "selectionSet":
      if let on = args["on"] as? Bool { saveState(["selection": on]) }
      reply(readState()["selection"] as? Bool != false)
    case "notifyStatus":
      notificationStatus { reply(["status": $0]) }
    case "notifyRequest":
      UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { [weak self] _, _ in
        self?.notificationStatus { reply(["status": $0]) }
      }
    case "notifySettings":
      let pane = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.bisu.desktop")!
      if !NSWorkspace.shared.open(pane) {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.notifications")!)
      }
    case "shortcuts":
      reply(shortcutRows())
    case "shortcutRecord":
      // An empty id stops a recording the page gave up on (its row was pressed again).
      let id = args["id"] as? String ?? ""
      if id.isEmpty { endRecording(""); reply(shortcutRows()) } else { recordShortcut(id, reply: reply) }
    case "shortcutReset":
      let id = args["id"] as? String ?? ""
      if id == "all" || Shortcuts.commands.contains(where: { $0.id == id }) { Shortcuts.reset(id) }
      applyHotKey()
      buildMainMenu()
      refreshTray()
      reply(shortcutRows())
    case "suggest":
      // How many suggestions are waiting unread, for the dot on the menu bar icon. The page reports
      // it after every poll, so nothing here has to know about the engine's schedule.
      setSuggest(args["n"] as? Int ?? 0)
      reply(nil)
    default:
      log("unknown bridge command:", cmd)
      reply(nil)
    }
  }

  private func respond(id: Int, value: Any?, on view: WKWebView?) {
    // JSONSerialization only accepts an array or a dictionary at the top level, so every value is
    // wrapped and the wrapper is stripped again: that keeps "true", 480 and "text" all working.
    var payload = "null"
    if let value,
       let data = try? JSONSerialization.data(withJSONObject: [value], options: [.fragmentsAllowed]),
       let wrapped = String(data: data, encoding: .utf8), wrapped.count >= 2 {
      payload = String(wrapped.dropFirst().dropLast())
    }
    view?.evaluateJavaScript("window.bisuHost.__reply(\(id), true, \(payload))", completionHandler: nil)
  }
}

// A borderless panel that can still take the keyboard, which is what a popover with a text field
// needs.
// MARK: show and teach

/// Records what the person does on the Mac for 보여 주고 가르치기, only between 시작 and 멈추기: switching apps,
/// the control clicked (its Accessibility role and name, never a screenshot), the text a field ended up with
/// (read once when the typing is done, not keystroke by keystroke) and shortcuts. Nothing is recorded from
/// password fields, while macOS has secure input on, or in bisu's own windows. The steps go to the engine,
/// which keeps them on this Mac and sends the model only a one-line description of each (ui/teach.mjs).
final class Recorder {
  private(set) var steps: [[String: Any]] = []
  private var tap: CFMachPort?
  private var source: CFRunLoopSource?
  private var appObserver: NSObjectProtocol?
  private var typingIn: AXUIElement?
  private var typingApp = ""
  var onChange: (() -> Void)?
  var recording: Bool { tap != nil }
  static let maxSteps = 200

  /// Listening to clicks and keys needs Input Monitoring; reading what was clicked needs Accessibility.
  static var inputAllowed: Bool { CGPreflightListenEventAccess() }

  func start() -> Bool {
    if tap != nil { return true }
    steps = []
    let mask = (CGEventMask(1) << CGEventMask(CGEventType.leftMouseDown.rawValue)) | (CGEventMask(1) << CGEventMask(CGEventType.keyDown.rawValue))
    let me = Unmanaged.passUnretained(self).toOpaque()
    guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask,
                                    callback: { _, type, event, info in
                                      if let info { Unmanaged<Recorder>.fromOpaque(info).takeUnretainedValue().handle(type, event) }
                                      return Unmanaged.passUnretained(event)
                                    }, userInfo: me) else { return false }
    tap = t
    source = CFMachPortCreateRunLoopSource(nil, t, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: t, enable: true)
    appObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] n in
      guard let self, let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
            app.processIdentifier != getpid() else { return }
      self.flushTyping()
      self.add(["type": "app", "app": app.localizedName ?? ""])
    }
    if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != getpid() {
      add(["type": "app", "app": front.localizedName ?? ""])
    }
    onChange?()
    return true
  }

  func stop() -> [[String: Any]] {
    flushTyping()
    if let t = tap { CGEvent.tapEnable(tap: t, enable: false) }
    if let s = source { CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .commonModes) }
    tap = nil
    source = nil
    if let o = appObserver { NSWorkspace.shared.notificationCenter.removeObserver(o) }
    appObserver = nil
    let out = steps
    steps = []
    onChange?()
    return out
  }

  private func add(_ s: [String: Any]) {
    guard steps.count < Recorder.maxSteps else { return }
    steps.append(s)
    onChange?()
  }
  private var frontName: String { NSWorkspace.shared.frontmostApplication?.localizedName ?? "" }
  private func attr(_ el: AXUIElement, _ name: String) -> String? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success else { return nil }
    return v as? String
  }
  private func isSecure(_ el: AXUIElement) -> Bool {
    attr(el, kAXRoleAttribute as String) == "AXSecureTextField" || attr(el, kAXSubroleAttribute as String) == "AXSecureTextField"
  }
  private func label(_ el: AXUIElement) -> String {
    for k in [kAXTitleAttribute as String, kAXDescriptionAttribute as String, "AXPlaceholderValue", kAXHelpAttribute as String] {
      if let t = attr(el, k), !t.isEmpty { return String(t.prefix(80)) }
    }
    let role = attr(el, kAXRoleAttribute as String) ?? ""
    if role == "AXButton" || role == "AXStaticText" || role == "AXMenuItem", let v = attr(el, kAXValueAttribute as String) { return String(v.prefix(80)) }
    return ""
  }
  private func pidOf(_ el: AXUIElement) -> pid_t { var pid: pid_t = 0; AXUIElementGetPid(el, &pid); return pid }

  /// A field the person typed into, read once now that they moved on.
  private func flushTyping() {
    guard let el = typingIn else { return }
    typingIn = nil
    if isSecure(el) || IsSecureEventInputEnabled() { return }
    let text = String((attr(el, kAXValueAttribute as String) ?? "").prefix(200))
    if !text.isEmpty { add(["type": "type", "app": typingApp, "field": label(el), "text": text]) }
  }

  fileprivate func handle(_ type: CGEventType, _ event: CGEvent) {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }; return }
    // A password prompt is open somewhere: nothing at all is recorded.
    if IsSecureEventInputEnabled() { return }
    if type == .leftMouseDown {
      flushTyping()
      let p = event.location
      var hit: AXUIElement?
      guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &hit) == .success, let el = hit else { return }
      let pid = pidOf(el)
      if pid == getpid() || isSecure(el) { return }
      add(["type": "click", "app": NSRunningApplication(processIdentifier: pid)?.localizedName ?? frontName,
           "role": attr(el, kAXRoleAttribute as String) ?? "", "title": label(el)])
    } else if type == .keyDown {
      let f = event.flags
      if NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() { return }
      if f.contains(.maskCommand) || f.contains(.maskControl) {
        flushTyping()
        let chars = (NSEvent(cgEvent: event)?.charactersIgnoringModifiers ?? "").uppercased()
        var keys = ""
        if f.contains(.maskControl) { keys += "⌃" }
        if f.contains(.maskAlternate) { keys += "⌥" }
        if f.contains(.maskShift) { keys += "⇧" }
        if f.contains(.maskCommand) { keys += "⌘" }
        add(["type": "shortcut", "app": frontName, "keys": keys + (chars.isEmpty ? "#\(event.getIntegerValueField(.keyboardEventKeycode))" : chars)])
      } else if typingIn == nil {
        var v: CFTypeRef?
        if AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &v) == .success, let v,
           CFGetTypeID(v) == AXUIElementGetTypeID() {
          let el = v as! AXUIElement
          let pid = pidOf(el)
          if pid != getpid() && !isSecure(el) { typingIn = el; typingApp = NSRunningApplication(processIdentifier: pid)?.localizedName ?? frontName }
        }
      }
    }
  }
}

final class Panel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

// MARK: - main

let app = NSApplication.shared
let shell = Shell()
if CommandLine.arguments.contains("--shortcut-test") { exit(shell.shortcutSelfTest() ? 0 : 1) }
app.delegate = shell
app.setActivationPolicy(.accessory)
app.run()
