module.exports = {
  packagerConfig: {
    asar: true,
    appBundleId: "com.growthlog.connector",
    appCategoryType: "public.app-category.productivity",
    executableName: "growth-log-connector",
    ignore: [
      /^\/(?:\.browser-automation-profile|\.claude|\.git|\.knou-playwright-profile|\.npm-cache|out|outputs|scripts|src|tests)(?:\/|$)/,
      /^\/dist\/tests(?:\/|$)/,
      /^\/(?:\.gitignore|README\.md|forge\.config\.cjs|package-lock\.json|tsconfig\.json)$/,
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
      platforms: ["darwin", "win32"],
    },
  ],
};
