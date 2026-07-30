import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";
import type { PlateRecognitionResult } from "./plate-recognition";

export type DashcamProtocol = "auto" | "rtsp" | "hls" | "mjpeg" | "snapshot";

export type DashcamFrame = PlateRecognitionResult & {
  imageBase64: string;
  capturedAt: number;
  protocol: Exclude<DashcamProtocol, "auto">;
};

export type DashcamStatus = {
  state:
    | "connecting"
    | "live"
    | "reconnecting"
    | "wifi"
    | "wifi_lost"
    | "error"
    | "stopped";
  message: string;
  protocol: string;
};

type DashcamStreamNative = {
  connectWifi(options: {
    ssid: string;
    password?: string;
  }): Promise<{ connected: boolean; ssid: string }>;
  start(options: {
    url: string;
    protocol: DashcamProtocol;
    username?: string;
    password?: string;
  }): Promise<{ started: boolean; protocol: string }>;
  stop(): Promise<void>;
  setWakeLock(options: { enabled: boolean }): Promise<{ enabled: boolean }>;
  prepareLocalNotifications(): Promise<{ granted: boolean }>;
  notifyEvent(options: {
    plate?: string;
    title?: string;
    body?: string;
  }): Promise<{ shown: boolean; reason?: string }>;
  openWifiSettings(): Promise<void>;
  getNetworkInfo(): Promise<{
    gateway: string;
    wifiEnabled: boolean;
    dashcamConnected: boolean;
    ssid: string;
    hasInternet: boolean;
  }>;
  addListener(
    eventName: "dashcamFrame",
    listener: (frame: DashcamFrame) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "dashcamStatus",
    listener: (status: DashcamStatus) => void,
  ): Promise<PluginListenerHandle>;
};

const DashcamStream = registerPlugin<DashcamStreamNative>("DashcamStream");

export function dashcamIsSupported() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export function connectDashcamWifi(options: {
  ssid: string;
  password?: string;
}) {
  return DashcamStream.connectWifi(options);
}

export function startDashcam(options: {
  url: string;
  protocol: DashcamProtocol;
  username?: string;
  password?: string;
}) {
  return DashcamStream.start(options);
}

export function stopDashcam() {
  return DashcamStream.stop();
}

export function setDashcamWakeLock(enabled: boolean) {
  return DashcamStream.setWakeLock({ enabled });
}

export function prepareDashcamNotifications() {
  return DashcamStream.prepareLocalNotifications();
}

export function notifyDashcamEvent(options: {
  plate?: string;
  title?: string;
  body?: string;
}) {
  return DashcamStream.notifyEvent(options);
}

export function openDashcamWifiSettings() {
  return DashcamStream.openWifiSettings();
}

export function getDashcamNetworkInfo() {
  return DashcamStream.getNetworkInfo();
}

export async function subscribeToDashcam(
  onFrame: (frame: DashcamFrame) => void,
  onStatus: (status: DashcamStatus) => void,
) {
  const frameListener = await DashcamStream.addListener("dashcamFrame", onFrame);
  const statusListener = await DashcamStream.addListener("dashcamStatus", onStatus);
  return () => {
    void frameListener.remove();
    void statusListener.remove();
  };
}
