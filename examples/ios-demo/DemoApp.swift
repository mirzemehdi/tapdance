import SwiftUI

// A deliberately small sign-in screen used to exercise Tapdance end to end:
// type into labelled fields, tap a button, wait for the result text.
@main
struct TapdanceDemoApp: App {
    var body: some Scene {
        WindowGroup { SignInView() }
    }
}

struct SignInView: View {
    @State private var email = ""
    @State private var password = ""
    @State private var message = ""

    var body: some View {
        VStack(spacing: 16) {
            Text("Tapdance Demo").font(.title).accessibilityIdentifier("title")
            TextField("Email", text: $email)
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("email")
            SecureField("Password", text: $password)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("password")
            Button("Sign in") {
                message = email.contains("@") && password.count >= 4 ? "Welcome, \(email)" : "Invalid email or password"
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("sign-in")
            Text(message).accessibilityIdentifier("result")
        }
        .padding(24)
    }
}
