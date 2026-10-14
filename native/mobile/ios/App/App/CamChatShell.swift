import AuthenticationServices
import Capacitor
import CryptoKit
import Foundation
import Security
import UIKit
import WebKit

/// Google and Discord reject OAuth inside WKWebView. This opens the system auth session and
/// brings the resulting session back into the webview. The verifier never leaves the app.
@objc(CamChatShellPlugin)
public class CamChatShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CamChatShellPlugin"
    public let jsName = "CamChatShell"
    public let pluginMethods: [CAPPluginMethod] = []

    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url else { return nil }
        if url.scheme == "camchat" {
            CamChatAuth.adopt(url: url, webView: webView)
            return NSNumber(value: true)
        }
        if CamChatAuth.isOAuth(url) {
            CamChatOAuth.shared.start(url: url, from: bridge?.viewController)
            return NSNumber(value: true)
        }
        return nil
    }
}

final class CamChatViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(CamChatShellPlugin())
        if let url = CamChatAuth.takePending() {
            CamChatAuth.adopt(url: url, webView: webView)
        }
    }
}

enum CamChatAuth {
    private static let verifierKey = "camchat.verifier"
    private static let challengeKey = "camchat.challenge"
    private static let expKey = "camchat.exp"
    private static var pending: URL?

    static func notePending(_ url: URL) {
        if url.scheme == "camchat" { pending = url }
    }

    static func takePending() -> URL? {
        let url = pending
        pending = nil
        return url
    }

    static func isOAuth(_ url: URL) -> Bool {
        guard url.scheme == "https" || url.scheme == "http" else { return false }
        let path = url.path.hasSuffix("/") && url.path.count > 1 ? String(url.path.dropLast()) : url.path
        guard path == "/api/auth/google" || path == "/api/auth/discord" else { return false }
        return url.host?.lowercased() == siteURL().host?.lowercased()
    }

    static func begin() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let verifier = base64url(Data(bytes))
        let digest = Data(SHA256.hash(data: Data(verifier.utf8)))
        let challenge = base64url(digest)
        let d = UserDefaults.standard
        d.set(verifier, forKey: verifierKey)
        d.set(challenge, forKey: challengeKey)
        d.set(Date().timeIntervalSince1970 + 600, forKey: expKey)
        return challenge
    }

    static func adopt(url: URL, webView: WKWebView?) {
        guard url.scheme == "camchat", url.host == "auth" else { return }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let challenge = items.first { $0.name == "nonce" }?.value ?? ""
        let token = items.first { $0.name == "token" }?.value ?? ""
        let error = items.first { $0.name == "error" }?.value ?? ""
        guard let verifier = takeVerifier(matching: challenge) else { return }
        let origin = siteURL()
        var target: URLComponents
        if !error.isEmpty {
            target = URLComponents(url: origin, resolvingAgainstBaseURL: false) ?? URLComponents()
            target.path = "/"
            target.queryItems = [URLQueryItem(name: "authError", value: error)]
        } else if !token.isEmpty {
            target = URLComponents(url: origin, resolvingAgainstBaseURL: false) ?? URLComponents()
            target.path = "/api/auth/native"
            target.queryItems = [
                URLQueryItem(name: "token", value: token),
                URLQueryItem(name: "verifier", value: verifier),
            ]
        } else {
            return
        }
        guard let next = target.url else { return }
        DispatchQueue.main.async { webView?.load(URLRequest(url: next)) }
    }

    private static func takeVerifier(matching challenge: String) -> String? {
        let d = UserDefaults.standard
        let exp = d.double(forKey: expKey)
        let stored = d.string(forKey: challengeKey) ?? ""
        let verifier = d.string(forKey: verifierKey) ?? ""
        if exp < Date().timeIntervalSince1970 {
            clear()
            return nil
        }
        guard stored == challenge, !verifier.isEmpty else { return nil }
        clear()
        return verifier
    }

    private static func clear() {
        let d = UserDefaults.standard
        d.removeObject(forKey: verifierKey)
        d.removeObject(forKey: challengeKey)
        d.removeObject(forKey: expKey)
    }

    static func siteURL() -> URL {
        if let file = Bundle.main.url(forResource: "capacitor.config", withExtension: "json"),
           let data = try? Data(contentsOf: file),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let server = json["server"] as? [String: Any],
           let raw = server["url"] as? String,
           let url = URL(string: raw) {
            return url
        }
        return URL(string: "https://chat.nano11bravo.com")!
    }

    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

final class CamChatOAuth: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = CamChatOAuth()
    private var session: ASWebAuthenticationSession?
    private weak var anchor: UIViewController?

    func start(url: URL, from viewController: UIViewController?) {
        let challenge = CamChatAuth.begin()
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        var items = parts.queryItems ?? []
        items.removeAll { $0.name == "client" || $0.name == "nonce" }
        items.append(URLQueryItem(name: "client", value: "native"))
        items.append(URLQueryItem(name: "nonce", value: challenge))
        parts.queryItems = items
        guard let authURL = parts.url else { return }
        anchor = viewController
        let webView = (viewController as? CAPBridgeViewController)?.webView
        let session = ASWebAuthenticationSession(url: authURL, callbackURLScheme: "camchat") { callback, _ in
            if let callback { CamChatAuth.adopt(url: callback, webView: webView) }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        self.session = session
        session.start()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor?.view.window ?? ASPresentationAnchor()
    }
}
