package com.mealog.app.staging;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import androidx.activity.EdgeToEdge;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** 본문 캔버스(--page-deep / --app-page-bg) — 하단 시스템 네비 공백과 동일 */
    private static final int PAGE_BG = Color.parseColor("#faf6f2");

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        EdgeToEdge.enable(this);
        applySystemBarsChrome();
    }

    @Override
    public void onResume() {
        super.onResume();
        applySystemBarsChrome();
    }

    private void applySystemBarsChrome() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            // edge-to-edge: 웹 #statusBarOverlay가 상단 색을 담당
            window.setStatusBarColor(Color.TRANSPARENT);
            // 앱 네비 숨김 시 시스템 네비 영역이 본문 배경으로 이어지도록
            window.setNavigationBarColor(PAGE_BG);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setNavigationBarContrastEnforced(false);
        }
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        if (controller != null) {
            // 헤더·상태바 오버레이가 밝은 면이므로 시스템 아이콘/시계는 진하게
            controller.setAppearanceLightStatusBars(true);
            controller.setAppearanceLightNavigationBars(true);
        }
    }
}
