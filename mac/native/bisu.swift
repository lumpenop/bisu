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

  // Whether dec holds a key, without reading it: referencing a missing key would stop the engine
  // from starting at all, which is worse than running without the optional one.
  private func decHas(_ node: String, _ name: String) -> Bool {
    let bridge = decBridge()
    let shim = "/Users/lumpen/.local/bin/dec-secret"
    var exe = node, args: [String]
    if let b = bridge { args = [b, "list"] } else if FileManager.default.isExecutableFile(atPath: shim) { exe = shim; args = ["list"] } else { return false }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return false }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return bin(data).range(of: "OPENAI_API_KEY", options: .caseInsensitive) != nil
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
      if decHas(node, "OPENAI_API_KEY") { env["OPENAI_API_KEY"] = "dec://OPENAI_API_KEY" }
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

  func getJSON(_ path: String, done: @escaping ([String: Any]?) -> Void) {
    var req = URLRequest(url: base.appendingPathComponent(path))
    req.timeoutInterval = 8
    req.setValue(token, forHTTPHeaderField: "X-Bisu-Token")
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

  static func capture(withSelection: Bool, selfName: String = "bisu") -> [String: Any] {
    let app = frontApp()
    let own = app?.caseInsensitiveCompare(selfName) == .orderedSame
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
  const subs = {context: new Set(), shown: new Set(), hidden: new Set()};
  const host = {
    panel: true,
    platform: 'darwin',
    context: () => call('context'),
    consume: () => call('consume'),
    session: (sessionId, cwd) => post('session', {sessionId, cwd}),
    hide: () => post('hide'),
    openFull: () => post('full'),
    resize: (width, height) => call('resize', {width, height}),
    bounds: () => call('bounds'),
    move: (x, y) => post('move', {x, y}),
    endMove: () => post('endMove'),
    accessibility: () => call('accessibility'),
    grantAccessibility: () => post('axGrant'),
    dismissAccessibility: () => post('axDismiss'),
    accessibilityHintShown: () => post('axShown'),
    selectionEnabled: () => call('selectionEnabled'),
    setSelectionEnabled: on => call('selectionSet', {on: !!on}),
    onContext: fn => { subs.context.add(fn); return () => subs.context.delete(fn) },
    onShown: fn => { subs.shown.add(fn); return () => subs.shown.delete(fn) },
    onHidden: fn => { subs.hidden.add(fn); return () => subs.hidden.delete(fn) },
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
  // shell moves the window here. Pointer capture keeps the drag alive past the window edge.
  let drag = null;
  const DRAG = '.dragbar, .chathead';
  const skip = 'button, input, textarea, select, a, .grip, [contenteditable]';
  document.addEventListener('pointerdown', async e => {
    if (e.button !== 0) return;
    const area = e.target.closest && e.target.closest(DRAG);
    if (!area || (e.target.closest && e.target.closest(skip))) return;
    const b = await host.bounds().catch(() => null);
    if (!b) return;
    drag = {sx: e.screenX, sy: e.screenY, x: b.x, y: b.y, id: e.pointerId, el: area};
    try { area.setPointerCapture(e.pointerId) } catch (err) {}
  }, true);
  document.addEventListener('pointermove', e => {
    if (!drag) return;
    host.move(drag.x + (e.screenX - drag.sx), drag.y + (e.screenY - drag.sy));
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
    alert.messageText = "bisu"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
    completionHandler()
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = "bisu"
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

final class Shell: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate, WKNavigationDelegate {
  private var statusItem: NSStatusItem!
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
  private var lastHidden = Date.distantPast
  private var axMenuItem: NSMenuItem?

  private let shortcutLabel = "⌥Space"
  private let minW: CGFloat = 380
  private let minH: CGFloat = 320

  // MARK: lifecycle

  func applicationDidFinishLaunching(_ notification: Notification) {
    ensureDirs()
    log("bisu (native) starting")
    engine = Engine()
    engine.onExit = { [weak self] in
      log("engine exited")
      self?.web?.evaluateJavaScript("window.bisuHost.__emit('engineDown')", completionHandler: nil)
    }
    buildStatusItem()
    buildPanel()
    registerHotKey()
    startEngineThenLoad()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationWillTerminate(_ notification: Notification) {
    engine?.stop()
    if let h = hotKey { UnregisterEventHotKey(h) }
  }

  // MARK: status item

  private func trayImage() -> NSImage? {
    guard let dir = Bundle.main.resourceURL?.appendingPathComponent("app/mac/assets") else { return nil }
    for name in ["trayTemplate@2x", "trayTemplate"] {
      if let img = NSImage(contentsOf: dir.appendingPathComponent("\(name).png")) {
        img.size = NSSize(width: 18, height: 18)
        img.isTemplate = true
        return img
      }
    }
    // A drawn fallback so the item is never invisible.
    let img = NSImage(size: NSSize(width: 18, height: 18))
    img.lockFocus()
    NSColor.black.setStroke()
    let path = NSBezierPath(ovalIn: NSRect(x: 2, y: 2, width: 14, height: 14))
    path.lineWidth = 2
    path.stroke()
    img.unlockFocus()
    img.isTemplate = true
    return img
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
    togglePanel()
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    // Nothing: the menu is rebuilt in statusMenu() so state (Accessibility, spend) is current.
  }

  private func statusMenu() -> NSMenu {
    let menu = NSMenu()
    let show = NSMenuItem(title: panel?.isVisible == true ? "bisu 숨기기" : "bisu 열기", action: #selector(toggleFromMenu), keyEquivalent: "")
    show.target = self
    menu.addItem(show)
    let full = NSMenuItem(title: "전체 창 (기록 · 설정)", action: #selector(openFullFromMenu), keyEquivalent: "o")
    full.target = self
    menu.addItem(full)
    menu.addItem(.separator())

    if let spend {
      let item = NSMenuItem(title: "오늘: \(spend)", action: nil, keyEquivalent: "")
      item.isEnabled = false
      menu.addItem(item)
    } else {
      engine?.getJSON("api/account") { [weak self] j in
        guard let self,
              let key = j?["key"] as? [String: Any],
              let daily = key["usage_daily"] as? Double else { return }
        self.spend = String(format: "$%.2f", daily)
      }
    }

    let selection = NSMenuItem(title: "선택한 텍스트 읽기", action: #selector(toggleSelection), keyEquivalent: "")
    selection.target = self
    selection.state = (readState()["selection"] as? Bool == false) ? .off : .on
    menu.addItem(selection)

    if !AXIsProcessTrusted() {
      let ax = NSMenuItem(title: "접근성 허용…", action: #selector(grantAccessibility), keyEquivalent: "")
      ax.target = self
      menu.addItem(ax)
    }

    menu.addItem(.separator())
    let quit = NSMenuItem(title: "bisu 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    menu.addItem(quit)
    return menu
  }

  @objc private func toggleFromMenu() { togglePanel() }
  @objc private func openFullFromMenu() { openFull() }

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

    let hotKeyID = EventHotKeyID(signature: OSType(0x62697375), id: 1) // 'bisu'
    let status = RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), hotKeyID,
                                    GetApplicationEventTarget(), 0, &hotKey)
    if status != noErr {
      log("hot key could not be registered (\(status))")
      statusItem?.button?.toolTip = "bisu · \(shortcutLabel) is taken by another app"
    }
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

  private func panelURL() -> URL {
    var comps = URLComponents(url: engine.base, resolvingAgainstBaseURL: false)!
    comps.path = "/"
    var items = [URLQueryItem(name: "panel", value: "1"), URLQueryItem(name: "token", value: engine.token)]
    if let id = activeChatId { items.append(URLQueryItem(name: "chat", value: id)) }
    comps.queryItems = items
    return comps.url!
  }

  private func positionUnderStatusItem() {
    guard let button = statusItem?.button else { return }
    let screen = button.window?.screen ?? NSScreen.main ?? NSScreen.screens[0]
    let area = screen.visibleFrame
    let saved = readState()
    let size = panel.frame.size
    if saved["panelMoved"] as? Bool == true, let p = saved["panel"] as? [String: Any],
       let x = p["x"] as? Double, let y = p["y"] as? Double {
      // The saved point is the panel's bottom-left; clamping happens on the whole rect so a screen
      // that was unplugged cannot leave the panel off-screen.
      let pt = clampToScreen(NSPoint(x: x, y: y), size: size)
      panel.setFrame(NSRect(x: pt.x, y: pt.y, width: size.width, height: size.height), display: true)
      return
    }
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
    positionUnderStatusItem()
    captureContextSoon()
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
    web.evaluateJavaScript("window.bisuHost.__emit('shown')", completionHandler: nil)
    log("panel shown", "web:", NSStringFromRect(web.frame), "hidden:", String(web.isHidden),
        "inWindow:", String(web.window != nil), "panel:", NSStringFromRect(panel.frame))
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
        self.loadPanel()
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

  func openFull() {
    if let w = fullWindow {
      w.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }
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
    w.title = "bisu"
    w.titlebarAppearsTransparent = true
    w.minSize = NSSize(width: 780, height: 520)
    w.contentView = view
    w.center()
    w.isReleasedWhenClosed = false
    w.delegate = self
    fullWindow = w

    var comps = URLComponents(url: engine.base, resolvingAgainstBaseURL: false)!
    comps.path = "/"
    var items = [URLQueryItem(name: "token", value: engine.token)]
    if let id = activeChatId { items.append(URLQueryItem(name: "chat", value: id)) }
    comps.queryItems = items
    view.load(URLRequest(url: comps.url!))
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
      openFull()
    case "resize":
      guard let w = args["width"] as? Double, let h = args["height"] as? Double else { return reply(nil) }
      let f = panel.frame
      let size = NSSize(width: max(minW, CGFloat(w)), height: max(minH, CGFloat(h)))
      // Anchored at the top left, which is where the grip is dragged from.
      let top = f.maxY
      let rect = NSRect(x: f.minX, y: top - size.height, width: size.width, height: size.height)
      panel.setFrame(rect, display: true)
      saveState(["panel": ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height], "panelMoved": true])
      reply(["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height])
    case "bounds":
      let f = panel.frame
      reply(["x": f.minX, "y": f.minY, "width": f.width, "height": f.height])
    case "move":
      guard let x = args["x"] as? Double, let y = args["y"] as? Double else { return }
      let size = panel.frame.size
      let origin = clampToScreen(NSPoint(x: x, y: y), size: size)
      panel.setFrameOrigin(origin)
    case "endMove":
      let f = panel.frame
      saveState(["panel": ["x": f.minX, "y": f.minY, "width": f.width, "height": f.height], "panelMoved": true])
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
final class Panel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

// MARK: - main

let app = NSApplication.shared
let shell = Shell()
app.delegate = shell
app.setActivationPolicy(.accessory)
app.run()
