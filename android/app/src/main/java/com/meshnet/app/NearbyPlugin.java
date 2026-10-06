package com.meshnet.app;

import android.Manifest;
import android.os.Build;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Thin bridge to Google Nearby Connections. It only moves bytes between phones over
 * Bluetooth / BLE / Wi-Fi Direct; all mesh routing, encryption and storage live in JS (mesh.js).
 */
@CapacitorPlugin(
    name = "Nearby",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT }),
        @Permission(alias = "wifi", strings = { Manifest.permission.NEARBY_WIFI_DEVICES })
    }
)
public class NearbyPlugin extends Plugin {
    private static final String SERVICE_ID = "com.meshnet.mesh";
    // P2P_CLUSTER = many-to-many topology, which is what a mesh needs.
    private static final Strategy STRATEGY = Strategy.P2P_CLUSTER;

    private ConnectionsClient client;
    private String localName;
    private final Set<String> connected = ConcurrentHashMap.newKeySet();
    private final Map<String, ConnectionInfo> pending = new ConcurrentHashMap<>();

    @Override
    public void load() {
        client = Nearby.getConnectionsClient(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        if (client != null) {
            client.stopAllEndpoints();
            client.stopAdvertising();
            client.stopDiscovery();
        }
    }

    // Android 12+ uses the "Nearby devices" permission for Bluetooth; location (even approximate) is only mandatory below that.
    private String[] requiredAliases() {
        List<String> aliases = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) aliases.add("bluetooth");
        else aliases.add("location");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) aliases.add("wifi");
        return aliases.toArray(new String[0]);
    }

    private String[] requestedAliases() {
        List<String> aliases = new ArrayList<>(Arrays.asList(requiredAliases()));
        if (!aliases.contains("location")) aliases.add("location");
        return aliases.toArray(new String[0]);
    }

    private boolean allGranted() {
        for (String alias : requiredAliases()) {
            if (getPermissionState(alias) != PermissionState.GRANTED) return false;
        }
        return true;
    }

    @PluginMethod
    public void start(PluginCall call) {
        String nodeId = call.getString("nodeId");
        String name = call.getString("name", "node");
        if (nodeId == null || !nodeId.matches("[a-f0-9]{16}")) {
            call.reject("valid nodeId required");
            return;
        }
        localName = nodeId + "|" + name;
        if (allGranted()) startRadios(call);
        else requestPermissionForAliases(requestedAliases(), call, "permissionsCallback");
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        if (allGranted()) startRadios(call);
        else call.reject("Allow 'Nearby devices' (and location) for Relay-Mesh in App info > Permissions");
    }

    private void startRadios(PluginCall call) {
        client.stopAdvertising();
        client.stopDiscovery();
        AdvertisingOptions advertising = new AdvertisingOptions.Builder().setStrategy(STRATEGY).build();
        DiscoveryOptions discovery = new DiscoveryOptions.Builder().setStrategy(STRATEGY).build();
        client.startAdvertising(localName, SERVICE_ID, lifecycle, advertising)
            .addOnSuccessListener(a -> client.startDiscovery(SERVICE_ID, discoveryCallback, discovery)
                .addOnSuccessListener(d -> call.resolve())
                .addOnFailureListener(e -> call.reject("Discovery failed: " + describe(e))))
            .addOnFailureListener(e -> call.reject("Advertising failed: " + describe(e)));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        client.stopAllEndpoints();
        client.stopAdvertising();
        client.stopDiscovery();
        connected.clear();
        pending.clear();
        call.resolve();
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String endpointId = call.getString("endpointId");
        if (endpointId == null) {
            call.reject("endpointId required");
            return;
        }
        client.requestConnection(localName, endpointId, lifecycle)
            .addOnSuccessListener(v -> call.resolve())
            .addOnFailureListener(e -> {
                if (e instanceof ApiException && ((ApiException) e).getStatusCode() == ConnectionsStatusCodes.STATUS_ALREADY_CONNECTED_TO_ENDPOINT) {
                    call.resolve();
                } else {
                    call.reject("Connect failed: " + describe(e));
                }
            });
    }

    @PluginMethod
    public void send(PluginCall call) {
        String endpointId = call.getString("endpointId");
        String data = call.getString("data");
        if (endpointId == null || data == null || !connected.contains(endpointId)) {
            call.reject("not connected");
            return;
        }
        byte[] bytes = data.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > ConnectionsClient.MAX_BYTES_DATA_SIZE) {
            call.reject("payload too large");
            return;
        }
        client.sendPayload(endpointId, Payload.fromBytes(bytes))
            .addOnSuccessListener(v -> call.resolve())
            .addOnFailureListener(e -> call.reject("Send failed: " + describe(e)));
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        String endpointId = call.getString("endpointId");
        if (endpointId != null) {
            client.disconnectFromEndpoint(endpointId);
            connected.remove(endpointId);
        }
        call.resolve();
    }

    private static String describe(Exception e) {
        if (e instanceof ApiException) {
            int code = ((ApiException) e).getStatusCode();
            return ConnectionsStatusCodes.getStatusCodeString(code) + " (" + code + ")";
        }
        return e.getMessage();
    }

    private JSObject endpoint(String endpointId, String endpointName) {
        JSObject o = new JSObject();
        o.put("endpointId", endpointId);
        o.put("endpointName", endpointName);
        return o;
    }

    private final EndpointDiscoveryCallback discoveryCallback = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String endpointId, @NonNull DiscoveredEndpointInfo info) {
            if (SERVICE_ID.equals(info.getServiceId())) notifyListeners("endpointFound", endpoint(endpointId, info.getEndpointName()));
        }

        @Override
        public void onEndpointLost(@NonNull String endpointId) {
            notifyListeners("endpointLost", endpoint(endpointId, null));
        }
    };

    // Links are auto-accepted: authenticity and confidentiality come from the app-level E2E encryption.
    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String endpointId, @NonNull ConnectionInfo info) {
            pending.put(endpointId, info);
            client.acceptConnection(endpointId, payloadCallback);
        }

        @Override
        public void onConnectionResult(@NonNull String endpointId, @NonNull ConnectionResolution result) {
            ConnectionInfo info = pending.remove(endpointId);
            if (!result.getStatus().isSuccess() || info == null) return;
            connected.add(endpointId);
            JSObject o = endpoint(endpointId, info.getEndpointName());
            o.put("incoming", info.isIncomingConnection());
            notifyListeners("connected", o);
        }

        @Override
        public void onDisconnected(@NonNull String endpointId) {
            connected.remove(endpointId);
            notifyListeners("disconnected", endpoint(endpointId, null));
        }
    };

    private final PayloadCallback payloadCallback = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String endpointId, @NonNull Payload payload) {
            if (payload.getType() != Payload.Type.BYTES || payload.asBytes() == null) return;
            JSObject o = new JSObject();
            o.put("endpointId", endpointId);
            o.put("data", new String(payload.asBytes(), StandardCharsets.UTF_8));
            notifyListeners("message", o);
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String endpointId, @NonNull PayloadTransferUpdate update) {}
    };
}
