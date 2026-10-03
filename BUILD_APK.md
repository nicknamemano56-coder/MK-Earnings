# MK Earnings Demo — APK build

This is an Android Studio project wrapping the existing User demo HTML. It preserves the localStorage-based data and keeps the app demo-only.

## Build
1. Install Android Studio with Android SDK 35.
2. Open `android/MKEarningsDemo`.
3. Let Gradle sync.
4. Build > Build Bundle(s) / APK(s) > Build APK(s).
5. The debug APK will be under `app/build/outputs/apk/debug/`.

## Backend
The current HTML defaults to `http://localhost:8787` for the backend. For a real phone, change the backend URL in the HTML/localStorage to your deployed HTTPS backend URL before building.

Do not put a private admin/service key inside the user APK.
