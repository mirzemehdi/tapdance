package dev.tapdance.demo;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * A one-screen sign-in form for exercising Tapdance on an Android emulator: labelled fields, a
 * button and a result text, built in code so the APK needs no resources or Gradle.
 */
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(64, 64, 64, 64);

        TextView title = new TextView(this);
        title.setText("Tapdance Demo");
        title.setTextSize(28);
        title.setGravity(Gravity.CENTER);

        EditText email = new EditText(this);
        email.setHint("Email");
        email.setContentDescription("Email");
        email.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);

        EditText password = new EditText(this);
        password.setHint("Password");
        password.setContentDescription("Password");
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);

        TextView result = new TextView(this);
        result.setGravity(Gravity.CENTER);
        result.setTextSize(18);

        Button signIn = new Button(this);
        signIn.setText("Sign in");
        signIn.setOnClickListener(v -> {
            String e = email.getText().toString();
            boolean ok = e.contains("@") && password.getText().length() >= 4;
            result.setText(ok ? "Welcome, " + e : "Invalid email or password");
        });

        root.addView(title);
        root.addView(email);
        root.addView(password);
        root.addView(signIn);
        root.addView(result);
        setContentView(root);
    }
}
