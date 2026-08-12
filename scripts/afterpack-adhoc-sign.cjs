/**
 * Ad-hoc signs the packaged macOS app.
 *
 * `mac.identity: null` in electron-builder.yml does not mean "sign with no
 * certificate" — it means skip signing entirely (see
 * app-builder-lib MacTargetHelper#handleNullIdentity). On Apple Silicon a
 * bundle with no signature at all is refused by the kernel, and clearing the
 * quarantine attribute does not help, because the problem is the missing
 * signature rather than the quarantine flag. Repackaging also invalidates the
 * ad-hoc signature Electron's own prebuilt binaries ship with, so there is
 * nothing usable left by this point.
 *
 * Signing ad-hoc (`--sign -`) produces a bundle that launches on both
 * architectures. It is still unidentified, so first-run on macOS needs
 * right-click -> Open, or `xattr -dr com.apple.quarantine <app>`. Proper
 * distribution would need a paid Developer ID plus notarisation; if that ever
 * happens, drop `identity: null` and remove this hook.
 *
 * Runs before electron-builder's own signing step and before the dmg/zip
 * targets are built, so the signature is what ends up in the artifacts.
 */
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  // codesign only exists on macOS, so a mac build made anywhere else cannot be
  // signed. Loud, because the artifact will not run on Apple Silicon.
  if (process.platform !== 'darwin') {
    console.warn(
      '\n  WARNING: building the macOS app off macOS — cannot ad-hoc sign it.\n' +
      '  The result will not launch on Apple Silicon. Build it on a macOS runner.\n'
    )
    return
  }

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // --deep is deprecated by Apple for distribution signing but remains the
  // practical way to ad-hoc sign an Electron bundle's nested helpers.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  console.log(`  ad-hoc signed ${appPath}`)
}
