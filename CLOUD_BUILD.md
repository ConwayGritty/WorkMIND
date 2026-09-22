# WorkMIND cloud build

This package does not require a local Mac.

## Stage 1 — compile validation
The included GitHub Actions workflow:
1. starts a GitHub-hosted macOS runner,
2. installs XcodeGen,
3. generates `WorkMIND.xcodeproj`,
4. builds the app for the iOS Simulator with code signing disabled,
5. saves the Xcode build log as a workflow artifact.

This proves the native source compiles before any Apple signing money or credentials are added.

## Stage 2 — install on an iPhone
For TestFlight or registered-device distribution, Apple requires Apple Developer Program distribution credentials. After enrollment, add signing/App Store Connect credentials as GitHub Actions secrets and extend the workflow to archive and upload the app.

Do not place certificates, private keys, API private keys, or passwords directly in this repository.
