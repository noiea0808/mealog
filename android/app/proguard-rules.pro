# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ── MEALOG 프로젝트 규칙 ──────────────────────────────────────────────
# R8(minifyEnabled)은 release 빌드타입에서 켜져 있다.
#
# 아래는 앱이 직접 필요로 하는 것만 남긴다. 다음은 이미 다른 곳에서 들어오므로
# 여기에 중복으로 적지 않는다:
#   - Capacitor 플러그인 keep, @CapacitorPlugin/@PluginMethod 보존
#     → @capacitor/android 의 consumerProguardFiles
#   - 소셜 로그인(ee.forgr.**), okhttp, jwtdecode, credentials, GMS auth
#     → @capgo/capacitor-social-login 의 consumer-proguard-rules.pro
#   - @JavascriptInterface 메서드, RuntimeVisibleAnnotations, enum, Parcelable
#     → AGP 기본 proguard-android-optimize.txt

# 난독화된 스택트레이스를 mapping.txt로 되돌릴 수 있게 라인 정보를 남긴다.
# 원본 파일명은 감추되 줄 번호는 유지한다.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
