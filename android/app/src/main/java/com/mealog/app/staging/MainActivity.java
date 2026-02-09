package com.mealog.app.staging;

import android.graphics.Color;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        EdgeToEdge.enable(this);
        // 하단 네비게이션 바(뒤로가기, 홈 등) 배경을 흰색으로
        getWindow().setNavigationBarColor(Color.WHITE);
    }
}
