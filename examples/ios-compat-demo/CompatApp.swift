// A UIKit test app for two agent-device checks (#153):
// - no launch screen in Info.plist, so iOS runs it on the legacy compatibility (letterboxed) screen,
//   which is where landscape taps once landed in the wrong place (#56);
// - a chain of nested views with identifiers, so the accessibility tree is deeper than 64 levels.
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let window = UIWindow(frame: UIScreen.main.bounds)
    window.rootViewController = CompatViewController()
    window.makeKeyAndVisible()
    self.window = window
    return true
  }
}

final class CompatViewController: UIViewController {
  private var taps = 0
  private let result = UILabel()

  override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .all }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .white

    let button = UIButton(type: .system)
    button.setTitle("Tap me", for: .normal)
    button.titleLabel?.font = .systemFont(ofSize: 28)
    button.accessibilityIdentifier = "tap-me"
    button.addTarget(self, action: #selector(tapped), for: .touchUpInside)

    result.text = "Taps: 0"
    result.accessibilityIdentifier = "result"

    // Nested views, each with an identifier so it stays in the accessibility tree.
    var parent: UIView = view
    for level in 1...80 {
      let child = UIView()
      child.accessibilityIdentifier = "level-\(level)"
      child.translatesAutoresizingMaskIntoConstraints = false
      parent.addSubview(child)
      NSLayoutConstraint.activate([
        child.topAnchor.constraint(equalTo: parent === view ? view.safeAreaLayoutGuide.topAnchor : parent.topAnchor, constant: parent === view ? 160 : 0),
        child.leadingAnchor.constraint(equalTo: parent.leadingAnchor),
        child.widthAnchor.constraint(equalToConstant: 220),
        child.heightAnchor.constraint(equalToConstant: 40),
      ])
      parent = child
    }
    let leaf = UILabel()
    leaf.text = "Deep leaf"
    leaf.accessibilityIdentifier = "deep-leaf"
    leaf.translatesAutoresizingMaskIntoConstraints = false
    parent.addSubview(leaf)
    NSLayoutConstraint.activate([leaf.leadingAnchor.constraint(equalTo: parent.leadingAnchor), leaf.topAnchor.constraint(equalTo: parent.topAnchor)])

    let stack = UIStackView(arrangedSubviews: [button, result])
    stack.axis = .vertical
    stack.spacing = 16
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
    ])
  }

  @objc private func tapped() {
    taps += 1
    result.text = "Taps: \(taps)"
  }
}
