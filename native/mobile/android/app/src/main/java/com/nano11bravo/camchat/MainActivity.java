package com.nano11bravo.camchat;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private final AppUpdate updates = new AppUpdate();

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CamChatShellPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        updates.onResume(this);
    }
}
