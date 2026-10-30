// dec-intern-cu — the hands and eyes dec-intern needs on this Mac.
//
//   dec-intern-cu trust                          is this process allowed to use Accessibility?
//   dec-intern-cu snapshot [--pid N] [--depth N] [--max N] [--all]
//                                          the frontmost (or given) app's window tree as JSON
//   dec-intern-cu click --x N --y N [--button right] [--count 2]
//   dec-intern-cu move --x N --y N
//   dec-intern-cu drag --x1 N --y1 N --x2 N --y2 N [--ms 300]
//   dec-intern-cu scroll --dy N [--dx N] [--x N] [--y N]
//   dec-intern-cu type --text "…"                types any script, Korean included
//   dec-intern-cu key --combo "cmd shift l"      modifier+key, or a bare key (return, tab, escape, delete, up…)
//   dec-intern-cu window                         frontmost window's id, frame and owning app
//
// Coordinates are screen points with the origin at the top-left of the main display, which is what
// the Accessibility API reports — so an element's frame can be clicked without any conversion.
// Accessibility reports the truth about what is on screen; the pixels are only a fallback.
import Cocoa
import ApplicationServices

// MARK: - output

func fail(_ message: String) -> Never {
  let payload: [String: Any] = ["ok": false, "error": message]
  if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  }
  exit(1)
}

func emit(_ dict: [String: Any]) {
  var payload = dict
  payload["ok"] = !(dict["error"] != nil)
  let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

// MARK: - args

struct Args {
  var values: [String: String] = [:]
  var flags: Set<String> = []

  init(_ argv: [String]) {
    var i = 0
    while i < argv.count {
      let a = argv[i]
      if a.hasPrefix("--") {
        let name = String(a.dropFirst(2))
        if i + 1 < argv.count && !argv[i + 1].hasPrefix("--") {
          values[name] = argv[i + 1]
          i += 2
        } else {
          flags.insert(name)
          i += 1
        }
      } else {
        i += 1
      }
    }
  }

  func int(_ name: String, _ fallback: Int? = nil) -> Int {
    if let v = values[name], let n = Int(v) { return n }
    if let f = fallback { return f }
    fail("--\(name) is required")
  }

  func str(_ name: String, _ fallback: String? = nil) -> String {
    if let v = values[name] { return v }
    if let f = fallback { return f }
    fail("--\(name) is required")
  }
}

// MARK: - accessibility values

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else { return nil }
  return value
}

func strAttr(_ el: AXUIElement, _ name: String) -> String? {
  guard let v = attr(el, name) else { return nil }
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  return nil
}

func boolAttr(_ el: AXUIElement, _ name: String) -> Bool? {
  (attr(el, name) as? NSNumber)?.boolValue
}

func frame(_ el: AXUIElement) -> [Double]? {
  guard let p = attr(el, "AXPosition"), let s = attr(el, "AXSize"),
        CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
  return [Double(point.x), Double(point.y), Double(size.width), Double(size.height)]
}

func actions(_ el: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(el, &names) == .success, let list = names as? [String] else { return [] }
  return list
}

func children(_ el: AXUIElement) -> [AXUIElement] {
  guard let v = attr(el, "AXChildren") as? [AXUIElement] else { return [] }
  return v
}

func truncate(_ s: String, _ n: Int) -> String {
  s.count <= n ? s : String(s.prefix(n)) + "…"
}

// MARK: - snapshot

func appElement(_ pid: pid_t) -> AXUIElement { AXUIElementCreateApplication(pid) }

func frontApp() -> (pid_t, String)? {
  guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
  return (app.processIdentifier, app.localizedName ?? app.bundleIdentifier ?? "?")
}

// Elements worth showing: ones a person could point at. A static label with no action and no text
// is noise, but text that can be read is worth keeping — dec-intern often needs to read the screen, not
// only click it.
func interesting(_ role: String, _ title: String?, _ value: String?, _ acts: [String], _ f: [Double]?) -> Bool {
  let label = (title ?? "").isEmpty ? (value ?? "") : title!
  if !label.isEmpty { return true }
  if !acts.isEmpty { return true }
  switch role {
  case "AXTextField", "AXTextArea", "AXButton", "AXCheckBox", "AXRadioButton", "AXLink", "AXMenuItem",
       "AXPopUpButton", "AXComboBox", "AXSlider", "AXTabGroup", "AXRow", "AXCell", "AXImage", "AXWebArea",
       "AXScrollArea", "AXOutline", "AXTable", "AXList", "AXGroup":
    return true
  default:
    return f != nil && f![2] > 0 && f![3] > 0 && role.hasPrefix("AX")
  }
}

func describe(_ el: AXUIElement, _ id: Int) -> [String: Any] {
  let role = strAttr(el, "AXRole") ?? "?"
  var out: [String: Any] = ["id": id, "role": role]
  if let t = strAttr(el, "AXTitle"), !t.isEmpty { out["title"] = truncate(t, 160) }
  if let d = strAttr(el, "AXDescription"), !d.isEmpty { out["desc"] = truncate(d, 160) }
  if let v = strAttr(el, "AXValue"), !v.isEmpty { out["value"] = truncate(v, 300) }
  if let p = strAttr(el, "AXPlaceholderValue"), !p.isEmpty { out["placeholder"] = truncate(p, 80) }
  if let f = frame(el) { out["frame"] = f.map { Int($0.rounded()) } }
  if let e = boolAttr(el, "AXEnabled"), e == false { out["disabled"] = true }
  if let s = boolAttr(el, "AXSelected"), s { out["selected"] = true }
  if let foc = boolAttr(el, "AXFocused"), foc { out["focused"] = true }
  let acts = actions(el)
  if !acts.isEmpty { out["actions"] = acts.map { $0.replacingOccurrences(of: "AX", with: "") } }
  if let url = strAttr(el, "AXURL"), !url.isEmpty { out["url"] = truncate(url, 200) }
  return out
}

func snapshot(pid: pid_t, depth: Int, max: Int, wholeApp: Bool) -> [String: Any] {
  let root = appElement(pid)
  guard let windows = attr(root, "AXWindows") as? [AXUIElement], !windows.isEmpty else {
    return ["app": frontApp()?.1 ?? "?", "windows": [], "elements": [], "note": "no windows"]
  }
  let window = windows[0]
  var out: [String: Any] = [:]
  out["app"] = frontApp()?.1 ?? "?"
  out["pid"] = Int(pid)
  if let t = strAttr(window, "AXTitle") { out["window"] = truncate(t, 160) }
  if let f = frame(window) { out["windowFrame"] = f.map { Int($0.rounded()) } }
  if let raw = attr(window, "AXFocusedUIElement"), CFGetTypeID(raw) == AXUIElementGetTypeID() {
    let focus = raw as! AXUIElement
    out["focused"] = describe(focus, -1)
  }

  var elements: [[String: Any]] = []
  var counter = 0
  var seen = 0
  // Breadth-first: the shallow elements are the ones a person names ("the Save button"), so they
  // must not be crowded out by a deep table's thousand rows.
  var queue: [(AXUIElement, Int)] = wholeApp ? [(root, 0)] : [(window, 0)]
  var head = 0
  while head < queue.count && elements.count < max {
    let (el, level) = queue[head]
    head += 1
    seen += 1
    if level > 0 {
      let role = strAttr(el, "AXRole") ?? "?"
      let acts = actions(el)
      let f = frame(el)
      if interesting(role, strAttr(el, "AXTitle"), strAttr(el, "AXValue"), acts, f) {
        var d = describe(el, counter)
        d["depth"] = level
        elements.append(d)
        counter += 1
      }
    }
    if level < depth {
      for child in children(el) { queue.append((child, level + 1)) }
    }
  }
  out["elements"] = elements
  out["truncated"] = elements.count >= max
  out["scanned"] = seen
  if let screen = NSScreen.main {
    out["display"] = [
      "width": Int(screen.frame.width), "height": Int(screen.frame.height), "scale": Double(screen.backingScaleFactor),
    ]
  }
  return out
}

func windowInfo() -> [String: Any] {
  guard let (pid, name) = frontApp() else { return ["error": "no frontmost app"] }
  let root = appElement(pid)
  guard let windows = attr(root, "AXWindows") as? [AXUIElement], let w = windows.first else {
    return ["app": name, "error": "no window"]
  }
  var out: [String: Any] = ["app": name, "pid": Int(pid)]
  if let f = frame(w) { out["frame"] = f.map { Int($0.rounded()) } }
  if let t = strAttr(w, "AXTitle") { out["title"] = t }
  if let screen = NSScreen.main { out["scale"] = Double(screen.backingScaleFactor) }
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  for info in list {
    if let owner = info[kCGWindowOwnerPID as String] as? pid_t, owner == pid,
       let num = info[kCGWindowNumber as String] as? Int,
       let bounds = info[kCGWindowBounds as String] as? [String: Any],
       let h = bounds["Height"] as? Double, h > 40 {
      out["windowId"] = num
      out["bounds"] = bounds
      break
    }
  }
  return out
}

// MARK: - input

func requireTrust() {
  guard AXIsProcessTrusted() else {
    fail("Accessibility permission is missing: allow 덱 인턴 (Dec Intern) in System Settings → Privacy & Security → Accessibility, then try again.")
  }
}

func point(_ x: Int, _ y: Int) -> CGPoint { CGPoint(x: x, y: y) }

func modifiers(_ names: [String]) -> CGEventFlags {
  var flags: CGEventFlags = []
  for name in names {
    switch name.lowercased() {
    case "cmd", "command", "⌘": flags.insert(.maskCommand)
    case "shift", "⇧": flags.insert(.maskShift)
    case "alt", "option", "opt", "⌥": flags.insert(.maskAlternate)
    case "ctrl", "control", "⌃": flags.insert(.maskControl)
    case "fn": flags.insert(.maskSecondaryFn)
    default: break
    }
  }
  return flags
}

let keyCodes: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
  "escape": 53, "esc": 53, "forwarddelete": 117, "home": 115, "end": 119,
  "pageup": 116, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20,
  "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34,
  "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, "-": 27, "=": 24, "[": 33, "]": 30,
  ";": 41, "'": 39, ",": 43, ".": 47, "/": 44, "\\": 42, "`": 50,
]

// MARK: - main

let argv = Array(CommandLine.arguments.dropFirst())
guard let command = argv.first else {
  fail("usage: dec-intern-cu <trust|snapshot|window|click|move|drag|scroll|type|key> [options]")
}
let args = Args(Array(argv.dropFirst()))

switch command {
case "trust":
  emit([
    "accessible": AXIsProcessTrusted(),
    "screenRecording": CGPreflightScreenCaptureAccess(),
    "pid": Int(ProcessInfo.processInfo.processIdentifier),
  ])

case "snapshot":
  let target: pid_t
  if let raw = args.values["pid"], let n = pid_t(raw) {
    target = n
  } else if let (pid, _) = frontApp() {
    target = pid
  } else {
    fail("no frontmost application")
  }
  emit(snapshot(pid: target, depth: args.int("depth", 14), max: args.int("max", 250), wholeApp: args.flags.contains("all")))

case "window":
  emit(windowInfo())

case "click":
  requireTrust()
  let p = point(args.int("x"), args.int("y"))
  CGWarpMouseCursorPosition(p)
  let button: CGMouseButton = args.values["button"] == "right" ? .right : .left
  let down: CGEventType = args.values["button"] == "right" ? .rightMouseDown : .leftMouseDown
  let up: CGEventType = args.values["button"] == "right" ? .rightMouseUp : .leftMouseUp
  let count = args.int("count", 1)
  if let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: button) {
    move.post(tap: .cghidEventTap)
  }
  usleep(50_000)
  for _ in 0..<max(1, count) {
    CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: p, mouseButton: button)?.post(tap: .cghidEventTap)
    usleep(25_000)
    CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: p, mouseButton: button)?.post(tap: .cghidEventTap)
    usleep(60_000)
  }
  emit(["clicked": [p.x, p.y], "button": args.values["button"] ?? "left"])

case "move":
  requireTrust()
  let p = point(args.int("x"), args.int("y"))
  CGWarpMouseCursorPosition(p)
  emit(["moved": [p.x, p.y]])

case "drag":
  requireTrust()
  let a = point(args.int("x1"), args.int("y1"))
  let b = point(args.int("x2"), args.int("y2"))
  let ms = args.int("ms", 300)
  CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: a, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(60_000)
  CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: a, mouseButton: .left)?.post(tap: .cghidEventTap)
  let steps = max(8, ms / 16)
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(useconds_t(max(1, ms * 1000 / steps)))
  }
  CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: b, mouseButton: .left)?.post(tap: .cghidEventTap)
  emit(["dragged": [a.x, a.y, b.x, b.y]])

case "scroll":
  requireTrust()
  if let x = args.values["x"], let y = args.values["y"], let xi = Int(x), let yi = Int(y) {
    CGWarpMouseCursorPosition(point(xi, yi))
    usleep(50_000)
  }
  let dy = args.int("dy", 0)
  let dx = args.int("dx", 0)
  CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)?
    .post(tap: .cghidEventTap)
  emit(["scrolled": [dx, dy]])

case "type":
  requireTrust()
  let text = args.str("text")
  for ch in text {
    let s = String(ch)
    var units = Array(s.utf16)
    if let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
       let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
      down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
      up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
    }
    usleep(8_000)
  }
  emit(["typed": truncate(text, 200), "length": text.count])

case "key":
  requireTrust()
  let parts = args.str("combo").lowercased().split(separator: "+").flatMap { $0.split(separator: " ") }.map(String.init)
  guard let last = parts.last, let code = keyCodes[last] else { fail("unknown key: \(args.str("combo"))") }
  let flags = modifiers(parts.dropLast().map { $0 })
  if let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) {
    down.flags = flags
    down.post(tap: .cghidEventTap)
  }
  usleep(20_000)
  if let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
    up.flags = flags
    up.post(tap: .cghidEventTap)
  }
  emit(["key": args.str("combo")])

default:
  fail("unknown command: \(command)")
}
