import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        for ctx in connectionOptions.urlContexts { CamChatAuth.notePending(ctx.url) }
        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CamChatViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for ctx in URLContexts where ctx.url.scheme == "camchat" {
            let webView = (window?.rootViewController as? CAPBridgeViewController)?.webView
            if webView == nil { CamChatAuth.notePending(ctx.url) }
            else { CamChatAuth.adopt(url: ctx.url, webView: webView) }
            return
        }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
