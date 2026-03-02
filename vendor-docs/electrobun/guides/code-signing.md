# Code Signing

## Mac

### Certificate Setup

Apple frequently distributes machines with outdated certificates, creating a frustrating cycle of regeneration and validation. Installing the complete Xcode suite via the App Store resolves many complications. Within Xcode's Settings under the Accounts tab, link your developer account and navigate to certificate management. Generate a "Developer ID Application" certificate, which should appear in Keychain Access under the Login keychain.

### Developer Portal Configuration

Register a new App Identifier in the developer portal, ensuring "App Attest" is enabled for Electrobun's code signing and notarization capabilities. Create an app-specific password at [https://account.apple.com/sign-in](https://account.apple.com/sign-in) under "App Specific Passwords" for use as your `ELECTROBUN_APPLEIDPASS`.

### Environment Variables

Locate these values and add them to your .zshrc file:

- **ELECTROBUN_DEVELOPER_ID**: Your certificate name (e.g., "My Corp Inc. (BGU899NB8T)")
- **ELECTROBUN_TEAMID**: The Team ID from your App Identifier
- **ELECTROBUN_APPLEID**: Your Apple ID email address
- **ELECTROBUN_APPLEIDPASS**: Your generated app-specific password

```bash
export ELECTROBUN_DEVELOPER_ID="My Corp Inc. (BGU899NB8T)"
export ELECTROBUN_TEAMID="BGU899NB8T"
export ELECTROBUN_APPLEID="you@example.com"
export ELECTROBUN_APPLEIDPASS="your-app-specific-password"
```

### Configuration File

In your electrobun.config file, enable code signing and notarization:

```json
{
    "build": {
        "mac": {
            "codesign": true,
            "notarize": true
        }
    }
}
```

Verify setup by running `echo $ELECTROBUN_TEAMID`.

## Unsigned Apps

Unsigned applications trigger macOS Gatekeeper quarantine restrictions on downloaded files, displaying an error message. Users can bypass this with:

```bash
xattr -cr /Applications/YourApp.app
```

Production applications should implement code signing and notarization for optimal user experience.
