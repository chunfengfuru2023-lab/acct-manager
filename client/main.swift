// 账号管家 · 原生客户端
// 一个真正的 macOS 窗口：内嵌 WKWebView 渲染管家面板（面板 UI 是网关的单一事实源，
// 网关更新功能窗口不用重新编译）。启动时确保网关活着，token 经 #fragment 注入。
// 本机只有 Command Line Tools（无 Xcode，SwiftUIMacros 缺失）——所以用纯 AppKit，
// 零 property wrapper 宏，swiftc 直接编（同 qoder-switch 的约束与做法）。

import Cocoa
import WebKit
import Security

// ── 钥匙串取面板 token（与 gateway 的 panel-token 同源）────────────────────
func keychainSecret(_ account: String) -> String? {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "acct-manager",
    kSecAttrAccount as String: account,
    kSecReturnData as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne,
  ]
  var item: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
        let data = item as? Data else { return nil }
  return String(data: data, encoding: .utf8)
}

// ── 网关健康检查 + 必要时 kickstart（launchd 是唯一管家）───────────────────
@discardableResult
func shellLaunch(_ args: [String]) -> Bool {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
  p.arguments = args
  p.standardOutput = FileHandle.nullDevice
  p.standardError = FileHandle.nullDevice
  do { try p.run(); p.waitUntilExit(); return p.terminationStatus == 0 } catch { return false }
}
func launchctlKickstart() {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/bin/bash")
  p.arguments = ["-c", "launchctl kickstart -k gui/$(id -u)/com.dsh.auto.acct-gateway"]
  p.standardOutput = FileHandle.nullDevice
  p.standardError = FileHandle.nullDevice
  try? p.run(); p.waitUntilExit()
}
func ensureGateway() {
  let healthy = shellLaunch(["-s", "-m", "2", "http://127.0.0.1:19400/health"])
  if healthy { return }
  launchctlKickstart()
  for _ in 0..<5 { // kickstart 后最多等 5 秒
    usleep(600_000)
    if shellLaunch(["-s", "-m", "2", "http://127.0.0.1:19400/health"]) { return }
  }
}

// ── 主窗口 ────────────────────────────────────────────────────────────────
final class PanelWindow: NSObject, WKNavigationDelegate {
  let window: NSWindow
  let web: WKWebView

  override init() {
    let cfg = WKWebViewConfiguration()
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1180, height: 820), configuration: cfg)
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable],
                      backing: .buffered, defer: false)
    super.init()
    window.title = "账号管家 · WorkBuddy + Qoder"
    window.contentView = web
    window.center()
    window.isReleasedWhenClosed = false
    web.navigationDelegate = self
    web.allowsBackForwardNavigationGestures = true
  }

  @objc func show() {
    ensureGateway()
    var urlString = "http://127.0.0.1:19400/panel"
    if let token = keychainSecret("panel-token") {
      urlString += "#token=\(token)"
    }
    guard let url = URL(string: urlString) else { return }
    web.load(URLRequest(url: url))
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, with error: Error) { reloadHint() }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { reloadHint() }
  private func reloadHint() {
    // 网关瞬时不可达：自动重试一次（launchd 会保它复活，窗口不该白屏）
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
      guard let self else { return }
      ensureGateway()
      if let u = self.web.url { self.web.load(URLRequest(url: u)) }
    }
  }
}

// ── App 生命周期（无 storyboard/nib，命令行编译的原生入口）────────────────
final class AppDelegate: NSObject, NSApplicationDelegate {
  let panel = PanelWindow()
  func applicationDidFinishLaunching(_ note: Notification) {
    NSApp.setActivationPolicy(.regular)
    buildMenu()
    panel.show()
  }
  func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    panel.show(); return true
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

  private func buildMenu() {
    let main = NSMenuItem()
    let mainMenu = NSMenu()
    let appItem = NSMenuItem()
    mainMenu.addItem(appItem)
    let appMenu = NSMenu()
    appItem.submenu = appMenu
    appMenu.addItem(withTitle: "刷新面板", action: #selector(PanelWindow.show), keyEquivalent: "r")
      .target = panel
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "退出账号管家", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    mainMenu.title = "账号管家"
    NSApp.mainMenu = mainMenu
    _ = main // AppKit 惯例：空根项
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
