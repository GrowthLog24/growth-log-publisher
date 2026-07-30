module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "com.growthlog.connector",
    appCategoryType: "public.app-category.productivity",
    executableName: "growth-log-connector",
    ignore: [
      /^\/(?:\.claude|\.git|\.knou-playwright-profile|\.npm-cache|out|outputs|scripts|tests)(?:\/|$)/,
      /^\/(?:\.gitignore|README\.md|forge\.config\.cjs|knou-helper\.mjs|package-lock\.json)$/,
    ],
    extendInfo: {
      CFBundleDisplayName: "Growth Log 연결 앱",
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
      },
    },
    protocols: [
      {
        name: "Growth Log 연결 앱",
        schemes: ["growthlog-connector"],
      },
    ],
  },
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
  ],
};
