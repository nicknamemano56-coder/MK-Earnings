# Build APK without Android Studio

## Easiest method: GitHub Actions

1. Create/sign in to a GitHub account.
2. Create a new repository (private is recommended).
3. Upload the contents of this project ZIP to the repository.
4. Open **Actions** → **Build MK Earnings APK**.
5. Click **Run workflow**.
6. Wait for the green check mark.
7. Open the completed workflow run.
8. Under **Artifacts**, download **MK-Earnings-Debug-APK**.
9. Extract it and install `app-debug.apk` on your Android phone.

No Android Studio is required on your PC.

## Important

This workflow creates a **debug/demo APK**. It is not a Play Store signed release. For Play Store distribution, a separate signing key and release build should be configured.

The project is demo-only and does not enable real-money deposits or payouts.

## Backend

The APK contains the current User/Admin HTML assets. The backend still needs to be deployed separately for multi-device cloud sync. Do not put a Supabase service-role key or other server secret inside the APK.
