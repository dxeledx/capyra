/**
 * 以源码字符串随 npm 的 dist 一起发布，首次使用时才在私有状态目录编译。
 * helper 只接受单个 JSON 请求并输出单个 JSON 结果，不启动网络或读取用户文件。
 */
export const MACOS_HELPER_SOURCE = String.raw`
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct HelperFailure: Error {
    let code: String
    let message: String
}

func fail(_ code: String, _ message: String) throws -> Never {
    throw HelperFailure(code: code, message: message)
}

func dictionary(_ value: Any?, _ name: String) throws -> [String: Any] {
    guard let result = value as? [String: Any] else { try fail("INVALID_REQUEST", "\(name) must be an object.") }
    return result
}

func string(_ value: Any?, _ name: String) throws -> String {
    guard let result = value as? String, !result.isEmpty else { try fail("INVALID_REQUEST", "\(name) must be a non-empty string.") }
    return result
}

func number(_ value: Any?, _ name: String) throws -> Double {
    guard let result = value as? NSNumber else { try fail("INVALID_REQUEST", "\(name) must be a number.") }
    let double = result.doubleValue
    guard double.isFinite else { try fail("INVALID_REQUEST", "\(name) must be finite.") }
    return double
}

func integer(_ value: Any?, _ name: String, _ minimum: Int, _ maximum: Int) throws -> Int {
    let double = try number(value, name)
    let result = Int(double)
    guard Double(result) == double, result >= minimum, result <= maximum else { try fail("INVALID_REQUEST", "\(name) is outside the allowed range.") }
    return result
}

func boolean(_ value: Any?, _ name: String) throws -> Bool {
    guard let result = value as? Bool else { try fail("INVALID_REQUEST", "\(name) must be a boolean.") }
    return result
}

func json(_ value: [String: Any]) {
    do {
        let data = try JSONSerialization.data(withJSONObject: value, options: [])
        FileHandle.standardOutput.write(data)
    } catch {
        FileHandle.standardOutput.write(Data(#"{"ok":false,"error":{"code":"ENCODING_FAILED","message":"Native helper could not encode its result."}}"#.utf8))
    }
}

final class EventState {
    private let lock = NSLock()
    private var terminating = false
    private var leftDown = false
    private var rightDown = false
    private var keysDown: Set<CGKeyCode> = []

    func postMouse(_ type: CGEventType, _ location: CGPoint, _ button: CGMouseButton, clickCount: Int64 = 0) throws {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: location, mouseButton: button) else {
            try fail("EVENT_CREATION_FAILED", "macOS could not create a mouse event.")
        }
        if clickCount > 0 { event.setIntegerValueField(.mouseEventClickState, value: clickCount) }
        lock.lock(); defer { lock.unlock() }
        guard !terminating else { try fail("CANCELLED", "Desktop input cleanup has started; no further events were posted.") }
        // 在同一把锁内先记录 down、再投递事件；终止清理无法穿过两者之间的窗口。
        if type == .leftMouseDown { leftDown = true }
        else if type == .rightMouseDown { rightDown = true }
        event.post(tap: .cghidEventTap)
        if type == .leftMouseUp { leftDown = false }
        else if type == .rightMouseUp { rightDown = false }
    }

    func postKeyboard(_ code: CGKeyCode, keyDown: Bool, flags: CGEventFlags = [], unicode: [UInt16]? = nil) throws {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: keyDown) else {
            try fail("EVENT_CREATION_FAILED", "macOS could not create a keyboard event.")
        }
        event.flags = flags
        if let unicode {
            unicode.withUnsafeBufferPointer { pointer in
                event.keyboardSetUnicodeString(stringLength: unicode.count, unicodeString: pointer.baseAddress)
            }
        }
        lock.lock(); defer { lock.unlock() }
        guard !terminating else { try fail("CANCELLED", "Desktop input cleanup has started; no further events were posted.") }
        // 普通键、修饰键和 Unicode 虚拟键都进入同一持有集合，异常时只释放 helper 自己发出的 down。
        if keyDown { keysDown.insert(code) }
        event.post(tap: .cghidEventTap)
        if !keyDown { keysDown.remove(code) }
    }

    func post(_ event: CGEvent) throws {
        lock.lock(); defer { lock.unlock() }
        guard !terminating else { try fail("CANCELLED", "Desktop input cleanup has started; no further events were posted.") }
        event.post(tap: .cghidEventTap)
    }

    // 一旦开始清理，后续动作不能再投递；持锁完成 release 可避免并发信号提前退出进程。
    func terminateAndRelease() {
        lock.lock()
        if terminating { lock.unlock(); return }
        terminating = true
        let releaseLeft = leftDown, releaseRight = rightDown, releaseKeys = Array(keysDown)
        leftDown = false; rightDown = false; keysDown.removeAll()
        let location = CGEvent(source: nil)?.location ?? .zero
        if releaseLeft { CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: location, mouseButton: .left)?.post(tap: .cghidEventTap) }
        if releaseRight { CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: location, mouseButton: .right)?.post(tap: .cghidEventTap) }
        for code in releaseKeys { CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap) }
        lock.unlock()
    }
}

let eventState = EventState()
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global(qos: .userInitiated))
let interruption = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global(qos: .userInitiated))
for source in [termination, interruption] {
    source.setEventHandler {
        eventState.terminateAndRelease()
        Foundation.exit(130)
    }
    source.resume()
}

func status() -> [String: Any] {
    return [
        "ok": true,
        "screenRecording": CGPreflightScreenCaptureAccess() ? "granted" : "not_granted",
        "accessibility": AXIsProcessTrusted() ? "granted" : "not_granted"
    ]
}

func resized(_ image: CGImage, width: Int, height: Int) throws -> CGImage {
    if image.width == width && image.height == height { return image }
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
        try fail("SCREENSHOT_ENCODING_FAILED", "Could not allocate a bounded screenshot buffer.")
    }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let output = context.makeImage() else { try fail("SCREENSHOT_ENCODING_FAILED", "Could not resize the screenshot.") }
    return output
}

func png(_ image: CGImage) throws -> Data {
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else {
        try fail("SCREENSHOT_ENCODING_FAILED", "Could not create the PNG encoder.")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { try fail("SCREENSHOT_ENCODING_FAILED", "Could not encode the screenshot as PNG.") }
    return output as Data
}

@available(macOS 14.0, *)
func screenshot(_ request: [String: Any]) async throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else {
        try fail("SCREEN_RECORDING_REQUIRED", "Screen Recording permission is not granted. Enable it for the Capyra/Terminal process in System Settings > Privacy & Security > Screen Recording, then restart that process.")
    }
    let maxWidth = try integer(request["maxWidth"], "maxWidth", 320, 4096)
    let maxHeight = try integer(request["maxHeight"], "maxHeight", 240, 4096)
    let maxBytes = try integer(request["maxBytes"], "maxBytes", 100_000, 1_500_000)
    let display = CGMainDisplayID()
    let bounds = CGDisplayBounds(display)
    let original: CGImage
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let selected = content.displays.first(where: { $0.displayID == display }) else {
            try fail("DISPLAY_UNAVAILABLE", "The primary display is not available in the active desktop session.")
        }
        let requestedScale = min(1.0, min(Double(maxWidth) / Double(selected.width), Double(maxHeight) / Double(selected.height)))
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int(Double(selected.width) * requestedScale))
        configuration.height = max(1, Int(Double(selected.height) * requestedScale))
        configuration.showsCursor = true
        configuration.capturesAudio = false
        configuration.scalesToFit = true
        configuration.preservesAspectRatio = true
        let filter = SCContentFilter(display: selected, excludingWindows: [])
        original = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    } catch let error as HelperFailure {
        throw error
    } catch {
        try fail("SCREENSHOT_FAILED", "The primary display could not be captured. Confirm Screen Recording permission and that an interactive desktop session is active.")
    }
    let initialScale = min(1.0, min(Double(maxWidth) / Double(original.width), Double(maxHeight) / Double(original.height)))
    var width = max(1, Int((Double(original.width) * initialScale).rounded(.down)))
    var height = max(1, Int((Double(original.height) * initialScale).rounded(.down)))
    var encoded = Data()
    for _ in 0..<10 {
        encoded = try png(try resized(original, width: width, height: height))
        if encoded.count <= maxBytes { break }
        let reduction = min(0.85, sqrt(Double(maxBytes) / Double(encoded.count)) * 0.92)
        let nextWidth = max(1, Int(Double(width) * reduction))
        let nextHeight = max(1, Int(Double(height) * reduction))
        if nextWidth == width && nextHeight == height { break }
        width = nextWidth; height = nextHeight
    }
    guard encoded.count <= maxBytes else {
        try fail("SCREENSHOT_TOO_LARGE", "The primary display screenshot could not be reduced below the safe payload limit.")
    }
    return [
        "ok": true,
        "screenshot": [
            "data": encoded.base64EncodedString(), "mimeType": "image/png", "width": width, "height": height,
            "bytes": encoded.count, "displayId": String(display),
            "coordinateBounds": ["x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.width, "height": bounds.height]
        ]
    ]
}

func displayBounds() -> CGRect { CGDisplayBounds(CGMainDisplayID()) }

func point(_ action: [String: Any], _ xName: String = "x", _ yName: String = "y") throws -> CGPoint {
    let value = CGPoint(x: try number(action[xName], xName), y: try number(action[yName], yName))
    let bounds = displayBounds()
    guard value.x >= bounds.minX, value.x < bounds.maxX, value.y >= bounds.minY, value.y < bounds.maxY else {
        try fail("COORDINATE_OUT_OF_BOUNDS", "Mapped desktop coordinate is outside the primary display. Read a fresh screenshot before acting.")
    }
    return value
}

func click(_ location: CGPoint, button: CGMouseButton, count: Int64) throws {
    let down: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
    for clickIndex in 1...count {
        try eventState.postMouse(down, location, button, clickCount: clickIndex)
        try eventState.postMouse(up, location, button, clickCount: clickIndex)
        if clickIndex < count { Thread.sleep(forTimeInterval: 0.08) }
    }
}

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "enter": 36, "l": 37, "j": 38,
    "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
    "tab": 48, "space": 49, "backspace": 51, "escape": 53, "f1": 122, "f2": 120, "f3": 99,
    "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103,
    "f12": 111, "home": 115, "page_up": 116, "delete": 117, "end": 119, "page_down": 121,
    "left": 123, "right": 124, "down": 125, "up": 126
]
let modifierCodes: [String: CGKeyCode] = ["command": 55, "shift": 56, "option": 58, "control": 59]
let modifierFlags: [String: CGEventFlags] = ["command": .maskCommand, "shift": .maskShift, "option": .maskAlternate, "control": .maskControl]

func keyboard(_ key: String, modifiers: [String]) throws {
    guard let code = keyCodes[key] else { try fail("UNSUPPORTED_KEY", "The requested key is not supported.") }
    var flags: CGEventFlags = []
    var held: [CGKeyCode] = []
    defer {
        for modifier in held.reversed() {
            try? eventState.postKeyboard(modifier, keyDown: false)
        }
    }
    for name in modifiers {
        guard let modifier = modifierCodes[name], let flag = modifierFlags[name] else { try fail("UNSUPPORTED_MODIFIER", "The requested key modifier is not supported.") }
        guard !held.contains(modifier) else { try fail("DUPLICATE_MODIFIER", "A key modifier was repeated.") }
        flags.insert(flag)
        try eventState.postKeyboard(modifier, keyDown: true, flags: flags)
        held.append(modifier)
    }
    try eventState.postKeyboard(code, keyDown: true, flags: flags)
    try eventState.postKeyboard(code, keyDown: false, flags: flags)
}

func unicodeText(_ text: String) throws {
    let values = Array(text.utf16)
    var offset = 0
    while offset < values.count {
        var end = min(values.count, offset + 20)
        // 固定大小分块若落在 UTF-16 代理项之间，则把完整非 BMP 字符留到下一块。
        if end < values.count && end > offset && (0xD800...0xDBFF).contains(values[end - 1]) && (0xDC00...0xDFFF).contains(values[end]) { end -= 1 }
        let chunk = Array(values[offset..<end])
        // Unicode 输入显式使用空 flags，不继承先前组合键的修饰状态，也不接触剪贴板。
        try eventState.postKeyboard(0, keyDown: true, flags: [], unicode: chunk)
        try eventState.postKeyboard(0, keyDown: false, flags: [])
        offset = end
    }
}

func perform(_ action: [String: Any]) throws {
    let type = try string(action["type"], "type")
    switch type {
    case "mouse_move":
        try eventState.postMouse(.mouseMoved, try point(action), .left)
    case "click":
        try click(point(action), button: .left, count: 1)
    case "double_click":
        try click(point(action), button: .left, count: 2)
    case "right_click":
        try click(point(action), button: .right, count: 1)
    case "drag":
        let start = try point(action), finish = try point(action, "toX", "toY")
        let duration = try integer(action["durationMs"], "durationMs", 0, 3000)
        try eventState.postMouse(.mouseMoved, start, .left)
        try eventState.postMouse(.leftMouseDown, start, .left, clickCount: 1)
        let steps = max(1, min(180, duration / 16))
        for step in 1...steps {
            let fraction = Double(step) / Double(steps)
            let location = CGPoint(x: start.x + (finish.x - start.x) * fraction, y: start.y + (finish.y - start.y) * fraction)
            try eventState.postMouse(.leftMouseDragged, location, .left, clickCount: 1)
            if duration > 0 { Thread.sleep(forTimeInterval: Double(duration) / Double(steps) / 1000.0) }
        }
        try eventState.postMouse(.leftMouseUp, finish, .left, clickCount: 1)
    case "scroll":
        let location = try point(action)
        try eventState.postMouse(.mouseMoved, location, .left)
        let deltaX = Int32(try integer(action["deltaX"], "deltaX", -2000, 2000))
        let deltaY = Int32(try integer(action["deltaY"], "deltaY", -2000, 2000))
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: deltaY, wheel2: deltaX, wheel3: 0) else {
            try fail("EVENT_CREATION_FAILED", "macOS could not create a scroll event.")
        }
        try eventState.post(event)
    case "type_text":
        try unicodeText(try string(action["text"], "text"))
    case "key":
        let names = action["modifiers"] as? [String] ?? []
        try keyboard(try string(action["key"], "key"), modifiers: names)
    case "wait":
        let duration = try integer(action["durationMs"], "durationMs", 0, 2000)
        Thread.sleep(forTimeInterval: Double(duration) / 1000.0)
    default:
        try fail("UNSUPPORTED_ACTION", "The requested desktop action is not supported.")
    }
}

func actionBatch(_ request: [String: Any]) throws -> [String: Any] {
    guard AXIsProcessTrusted() else {
        try fail("ACCESSIBILITY_REQUIRED", "Accessibility permission is not granted. Enable it for the Capyra/Terminal process in System Settings > Privacy & Security > Accessibility, then restart that process.")
    }
    let display = CGMainDisplayID(), bounds = CGDisplayBounds(display)
    let expectedDisplay = try string(request["expectedDisplayId"], "expectedDisplayId")
    let expectedBounds = try dictionary(request["expectedBounds"], "expectedBounds")
    let expected = CGRect(x: try number(expectedBounds["x"], "expectedBounds.x"),
                          y: try number(expectedBounds["y"], "expectedBounds.y"),
                          width: try number(expectedBounds["width"], "expectedBounds.width"),
                          height: try number(expectedBounds["height"], "expectedBounds.height"))
    let sameBounds = abs(bounds.origin.x - expected.origin.x) < 0.5 && abs(bounds.origin.y - expected.origin.y) < 0.5
        && abs(bounds.width - expected.width) < 0.5 && abs(bounds.height - expected.height) < 0.5
    guard String(display) == expectedDisplay && sameBounds else {
        try fail("DISPLAY_CHANGED", "The primary display changed after the referenced screenshot. Read a fresh screenshot before acting.")
    }
    guard let actions = request["actions"] as? [[String: Any]], !actions.isEmpty, actions.count <= 24 else {
        try fail("INVALID_REQUEST", "actions must contain 1 to 24 items.")
    }
    var completed = 0
    for (index, action) in actions.enumerated() {
        do {
            try perform(action)
            completed += 1
        } catch let error as HelperFailure {
            eventState.terminateAndRelease()
            return ["ok": false, "completedActions": completed, "failedAction": index,
                    "error": ["code": error.code, "message": error.message]]
        }
    }
    eventState.terminateAndRelease()
    return ["ok": true, "completedActions": completed]
}

func run() async {
    defer { eventState.terminateAndRelease() }
    do {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        guard input.count <= 250_000 else { try fail("INVALID_REQUEST", "Native helper request is too large.") }
        let request = try dictionary(try JSONSerialization.jsonObject(with: input), "request")
        let operation = try string(request["operation"], "operation")
        switch operation {
        case "status": json(status())
        case "screenshot":
            if #available(macOS 14.0, *) { json(try await screenshot(request)) }
            else { try fail("UNSUPPORTED_OS_VERSION", "Computer Use requires macOS 14 or newer.") }
        case "actions": json(try actionBatch(request))
        default: try fail("INVALID_REQUEST", "Unknown native helper operation.")
        }
    } catch let error as HelperFailure {
        json(["ok": false, "error": ["code": error.code, "message": error.message]])
    } catch {
        json(["ok": false, "error": ["code": "NATIVE_HELPER_FAILED", "message": "The macOS desktop helper could not complete the request."]])
    }
}

Task {
    await run()
    Foundation.exit(0)
}
dispatchMain()
`;
