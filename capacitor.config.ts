import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dk.pladetjek.app",
  appName: "Pladetjek",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
};

export default config;
