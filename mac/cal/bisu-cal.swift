// bisu-cal — the person's Calendar and Reminders, through EventKit: the same events and to-dos their
// iPhone shows.
//
// One JSON request on stdin, one JSON answer on stdout ({"ok": true, …} or {"ok": false, "error": …}):
//   {"op":"status"}                                    access for events and reminders, without asking
//   {"op":"calendars"}                                 event calendars and reminder lists
//   {"op":"events","from":"2026-10-27","to":"2026-11-02"}            both days included
//   {"op":"add_event","title":…,"start":"2026-10-28 15:00","end":"2026-10-28 16:00","all_day":false,
//      "location":…,"notes":…,"calendar":…,"alert_minutes":10,"repeat":"weekly","repeat_until":"2026-12-31"}
//   {"op":"update_event","id":…,"occurrence":"2026-10-28 10:00","all":false, …the fields to change}
//   {"op":"delete_event","id":…,"occurrence":…,"all":false}
//   {"op":"reminders","list":…,"completed":false}
//   {"op":"add_reminder","title":…,"due":"2026-10-28 09:00","list":…,"notes":…,"priority":"high"}
//   {"op":"update_reminder","id":…, …the fields to change, "completed":true}
//   {"op":"delete_reminder","id":…}
//
// Times are local wall-clock time both ways: "YYYY-MM-DD HH:MM", or "YYYY-MM-DD" for all-day events
// and reminders due on a day. engine/calendar.mjs turns these into tools and checks the arguments
// first; this file only talks to EventKit.
//
// The first use asks macOS for access. macOS asks on behalf of the app that started this (bisu), so
// bisu's Info.plist carries the reasons; this binary carries them too, for a run from a terminal.
import EventKit
import Foundation

let store = EKEventStore()
let cal = Calendar.current

// MARK: - output

func emit(_ dict: [String: Any]) -> Never {
  var payload = dict
  if payload["ok"] == nil { payload["ok"] = true }
  let data = (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])) ?? Data("{\"ok\":false,\"error\":\"could not encode the answer\"}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  exit((payload["ok"] as? Bool) == false ? 1 : 0)
}
func fail(_ message: String) -> Never { emit(["ok": false, "error": message]) }

// MARK: - times

func formatter(_ format: String) -> DateFormatter {
  let f = DateFormatter()
  f.locale = Locale(identifier: "en_US_POSIX")
  f.timeZone = .current
  f.dateFormat = format
  return f
}
let fmtTime = formatter("yyyy-MM-dd HH:mm")
let fmtDay = formatter("yyyy-MM-dd")

// (date, has a time of day)
func parse(_ any: Any?) -> (Date, Bool)? {
  guard let s = (any as? String)?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
  let t = s.replacingOccurrences(of: "T", with: " ")
  if let d = fmtTime.date(from: t) { return (d, true) }
  if let d = fmtDay.date(from: t) { return (d, false) }
  return nil
}
func dayAfter(_ d: Date) -> Date { cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: d))! }

// MARK: - access

// EKAuthorizationStatus: 0 not asked, 1 restricted, 2 denied, 3 full access (the old "authorized"), 4 write only.
func statusName(_ type: EKEntityType) -> String {
  switch EKEventStore.authorizationStatus(for: type).rawValue {
  case 0: return "not_asked"
  case 1: return "restricted"
  case 2: return "denied"
  case 3: return "full"
  case 4: return "write_only"
  default: return "unknown"
  }
}

func access(_ type: EKEntityType) -> Bool {
  let status = EKEventStore.authorizationStatus(for: type).rawValue
  if status == 3 { return true }
  if status != 0 && status != 4 { return false }
  let done = DispatchSemaphore(value: 0)
  var granted = false
  if #available(macOS 14.0, *) {
    if type == .event { store.requestFullAccessToEvents { g, _ in granted = g; done.signal() } }
    else { store.requestFullAccessToReminders { g, _ in granted = g; done.signal() } }
  } else {
    store.requestAccess(to: type) { g, _ in granted = g; done.signal() }
  }
  done.wait()
  return granted
}
func needEvents() { if !access(.event) { fail("access-denied:calendar") } }
func needReminders() { if !access(.reminder) { fail("access-denied:reminders") } }

// MARK: - events

let FREQ: [String: EKRecurrenceFrequency] = ["daily": .daily, "weekly": .weekly, "monthly": .monthly, "yearly": .yearly]
func freqName(_ f: EKRecurrenceFrequency) -> String {
  switch f { case .daily: return "daily"; case .weekly: return "weekly"; case .monthly: return "monthly"; case .yearly: return "yearly"; @unknown default: return "repeating" }
}

func eventJSON(_ e: EKEvent) -> [String: Any] {
  let allDay = e.isAllDay
  // An all-day event ends at the start of the day after (or the last second of its last day); people
  // and the tools mean the last day itself.
  let lastDay = allDay ? cal.date(byAdding: .second, value: -1, to: e.endDate)! : e.endDate!
  return [
    "id": e.eventIdentifier ?? "",
    "title": e.title ?? "",
    "start": allDay ? fmtDay.string(from: e.startDate) : fmtTime.string(from: e.startDate),
    "end": allDay ? fmtDay.string(from: max(lastDay, e.startDate)) : fmtTime.string(from: e.endDate),
    "all_day": allDay,
    "location": e.location ?? "",
    "notes": String((e.notes ?? "").prefix(300)),
    "calendar": e.calendar?.title ?? "",
    "recurring": e.hasRecurrenceRules ? freqName(e.recurrenceRules?.first?.frequency ?? .weekly) : "",
    "writable": e.calendar?.allowsContentModifications ?? false,
  ]
}

func calendarNamed(_ name: Any?, for type: EKEntityType) -> EKCalendar? {
  guard let n = (name as? String)?.trimmingCharacters(in: .whitespaces), !n.isEmpty else { return nil }
  let all = store.calendars(for: type).filter { $0.allowsContentModifications }
  return all.first { $0.title == n } ?? all.first { $0.title.localizedCaseInsensitiveContains(n) }
}

// A recurring event's occurrences share one identifier: the start of the one meant picks it out.
func findEvent(_ id: String, _ occurrence: Any?) -> EKEvent? {
  if let (d, _) = parse(occurrence) {
    let pred = store.predicateForEvents(withStart: cal.startOfDay(for: d), end: dayAfter(d), calendars: nil)
    let same = store.events(matching: pred).filter { $0.eventIdentifier == id }
    if let e = same.first(where: { abs($0.startDate.timeIntervalSince(d)) < 60 }) ?? same.first { return e }
  }
  return store.event(withIdentifier: id)
}

func apply(_ e: EKEvent, _ req: [String: Any]) {
  if let t = req["title"] as? String, !t.isEmpty { e.title = t }
  if let l = req["location"] as? String { e.location = l.isEmpty ? nil : l }
  if let n = req["notes"] as? String { e.notes = n.isEmpty ? nil : n }
  // Moving keeps the length; an all-day event that gets a time becomes an hour long.
  let duration = e.isAllDay ? 3600 : max(e.endDate.timeIntervalSince(e.startDate), 60)
  if let (s, timed) = parse(req["start"]) {
    if timed {
      e.isAllDay = false
      e.startDate = s
      e.endDate = parse(req["end"]).map { $0.0 } ?? s.addingTimeInterval(duration)
    } else {
      e.isAllDay = true
      e.startDate = s
      e.endDate = parse(req["end"]).map { $0.0 } ?? s
    }
  } else if let (en, _) = parse(req["end"]) {
    e.endDate = en
  }
  if let c = calendarNamed(req["calendar"], for: .event) { e.calendar = c }
}

// MARK: - reminders

func fetch(_ pred: NSPredicate) -> [EKReminder] {
  let done = DispatchSemaphore(value: 0)
  var items: [EKReminder] = []
  store.fetchReminders(matching: pred) { r in items = r ?? []; done.signal() }
  done.wait()
  return items
}

func reminderJSON(_ r: EKReminder) -> [String: Any] {
  var due = ""
  if let c = r.dueDateComponents, let d = cal.date(from: c) {
    due = (c.hour != nil && c.hour != NSDateComponentUndefined) ? fmtTime.string(from: d) : fmtDay.string(from: d)
  }
  let p = r.priority
  return [
    "id": r.calendarItemIdentifier,
    "title": r.title ?? "",
    "due": due,
    "list": r.calendar?.title ?? "",
    "completed": r.isCompleted,
    "notes": String((r.notes ?? "").prefix(300)),
    "priority": p == 0 ? "" : p <= 4 ? "high" : p == 5 ? "medium" : "low",
  ]
}

func setDue(_ r: EKReminder, _ any: Any?) {
  guard let s = any as? String else { return }
  for a in r.alarms ?? [] { r.removeAlarm(a) }
  guard let (d, timed) = parse(s) else { r.dueDateComponents = nil; return }
  r.dueDateComponents = cal.dateComponents(timed ? [.year, .month, .day, .hour, .minute] : [.year, .month, .day], from: d)
  // A time of day means "tell me then": that is the alarm, as Reminders itself sets it.
  if timed { r.addAlarm(EKAlarm(absoluteDate: d)) }
}

func setPriority(_ r: EKReminder, _ any: Any?) {
  guard let p = any as? String else { return }
  r.priority = ["high": 1, "medium": 5, "low": 9][p] ?? 0
}

// MARK: - requests

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let req = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any], let op = req["op"] as? String else {
  fail("send one JSON object with an op")
}

switch op {
case "status":
  emit(["events": statusName(.event), "reminders": statusName(.reminder)])

case "calendars":
  needEvents()
  let ev = store.calendars(for: .event)
  let defEv = store.defaultCalendarForNewEvents?.calendarIdentifier
  var lists: [[String: Any]] = []
  if access(.reminder) {
    let defR = store.defaultCalendarForNewReminders()?.calendarIdentifier
    lists = store.calendars(for: .reminder).map { ["name": $0.title, "writable": $0.allowsContentModifications, "default": $0.calendarIdentifier == defR] }
  }
  emit(["calendars": ev.map { ["name": $0.title, "writable": $0.allowsContentModifications, "default": $0.calendarIdentifier == defEv] }, "lists": lists])

case "events":
  needEvents()
  guard let (from, _) = parse(req["from"]), let (to, _) = parse(req["to"]) else { fail("from and to are days, YYYY-MM-DD") }
  let pred = store.predicateForEvents(withStart: cal.startOfDay(for: from), end: dayAfter(to), calendars: nil)
  let events = store.events(matching: pred).sorted { $0.startDate < $1.startDate }
  emit(["events": events.prefix(300).map(eventJSON)])

case "add_event":
  needEvents()
  guard let title = req["title"] as? String, !title.isEmpty, parse(req["start"]) != nil else { fail("title and start are needed") }
  let e = EKEvent(eventStore: store)
  e.title = title
  e.startDate = Date(); e.endDate = Date()
  apply(e, req)
  guard let c = calendarNamed(req["calendar"], for: .event) ?? store.defaultCalendarForNewEvents else { fail("there is no calendar to add to") }
  e.calendar = c
  if let m = req["alert_minutes"] as? Double { e.addAlarm(EKAlarm(relativeOffset: -m * 60)) }
  if let f = req["repeat"] as? String, let freq = FREQ[f] {
    let end = parse(req["repeat_until"]).map { EKRecurrenceEnd(end: dayAfter($0.0).addingTimeInterval(-1)) }
    e.addRecurrenceRule(EKRecurrenceRule(recurrenceWith: freq, interval: 1, end: end))
  }
  do { try store.save(e, span: .thisEvent, commit: true) } catch { fail("could not save: \(error.localizedDescription)") }
  emit(["event": eventJSON(e)])

case "update_event":
  needEvents()
  guard let id = req["id"] as? String, let e = findEvent(id, req["occurrence"]) else { fail("no such event") }
  let before = eventJSON(e)
  apply(e, req)
  do { try store.save(e, span: (req["all"] as? Bool) == true ? .futureEvents : .thisEvent, commit: true) } catch { fail("could not save: \(error.localizedDescription)") }
  emit(["before": before, "event": eventJSON(e)])

case "delete_event":
  needEvents()
  guard let id = req["id"] as? String, let e = findEvent(id, req["occurrence"]) else { fail("no such event") }
  let gone = eventJSON(e)
  do { try store.remove(e, span: (req["all"] as? Bool) == true ? .futureEvents : .thisEvent, commit: true) } catch { fail("could not delete: \(error.localizedDescription)") }
  emit(["event": gone])

case "reminders":
  needReminders()
  let lists = calendarNamed(req["list"], for: .reminder).map { [$0] }
  var items = fetch(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists))
  if (req["completed"] as? Bool) == true {
    // Done ones from the last month: all of them can be thousands.
    items += fetch(store.predicateForCompletedReminders(withCompletionDateStarting: cal.date(byAdding: .day, value: -30, to: Date()), ending: nil, calendars: lists))
  }
  emit(["reminders": items.prefix(300).map(reminderJSON)])

case "add_reminder":
  needReminders()
  guard let title = req["title"] as? String, !title.isEmpty else { fail("title is needed") }
  let r = EKReminder(eventStore: store)
  r.title = title
  guard let c = calendarNamed(req["list"], for: .reminder) ?? store.defaultCalendarForNewReminders() else { fail("there is no reminders list to add to") }
  r.calendar = c
  setDue(r, req["due"])
  setPriority(r, req["priority"])
  if let n = req["notes"] as? String, !n.isEmpty { r.notes = n }
  do { try store.save(r, commit: true) } catch { fail("could not save: \(error.localizedDescription)") }
  emit(["reminder": reminderJSON(r)])

case "update_reminder":
  needReminders()
  guard let id = req["id"] as? String, let r = store.calendarItem(withIdentifier: id) as? EKReminder else { fail("no such reminder") }
  let before = reminderJSON(r)
  if let t = req["title"] as? String, !t.isEmpty { r.title = t }
  if let n = req["notes"] as? String { r.notes = n.isEmpty ? nil : n }
  if let c = calendarNamed(req["list"], for: .reminder) { r.calendar = c }
  setDue(r, req["due"])
  setPriority(r, req["priority"])
  if let done = req["completed"] as? Bool { r.isCompleted = done }
  do { try store.save(r, commit: true) } catch { fail("could not save: \(error.localizedDescription)") }
  emit(["before": before, "reminder": reminderJSON(r)])

case "delete_reminder":
  needReminders()
  guard let id = req["id"] as? String, let r = store.calendarItem(withIdentifier: id) as? EKReminder else { fail("no such reminder") }
  let gone = reminderJSON(r)
  do { try store.remove(r, commit: true) } catch { fail("could not delete: \(error.localizedDescription)") }
  emit(["reminder": gone])

default:
  fail("unknown op \(op)")
}
