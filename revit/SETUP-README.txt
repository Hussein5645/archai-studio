ArchAI Revit Plugin Setup — 0.5.0 beta 1

Run ArchAI-Revit-Setup-0.5.0-beta.1.exe on Windows.
Choose Revit 2024, 2025, 2026 and/or 2027, then Continue > Install.
Close Revit first. No administrator privileges are required.

Setup detects standard Revit installations and lets you select a custom
installation's year manually. It downloads only the selected plugin packages
from the archai-revit Cloudflare bucket, verifies their pinned SHA-256 checksums,
then installs them for the current Windows user. Internet access is required.
It requires .NET Framework 4.8, which is normally present on supported Windows
and Revit installations. The setup EXE has no additional DLL dependencies.

After installation, open a Revit project and use:
the ArchAI tab: Send to ArchAI (save this model for ArchAI),
Open .AIR (bring an ArchAI document into Revit), Live link (sync with the ArchAI
desktop app as you work) or Open in VR (walk through it in a headset)

For generated doors/windows/columns/solid families, install the matching Revit
English metric family templates through Autodesk. This installer does not
redistribute Autodesk templates, API DLLs or Revit itself.

Repair or remove:
Run this setup again and select Install / repair or Remove plugin.
You can also find ArchAI AIR Importer for Revit (Beta) in Windows Installed apps.
Removal preserves your Revit projects, import reports, setup logs and other
user-created files. The small maintenance EXE remains in LocalAppData/ArchAI.

Verification:
All four plugin builds compiled. The setup was tested using public downloads
and isolated installation, repair, removal, rollback and tamper checks.
In-Revit runtime and fidelity testing is still pending. Some source elements
are approximated or unsupported. Review each import report and plugin README.
This beta installer is unsigned.

Hosting:
Downloads currently use Cloudflare's public r2.dev URL. This endpoint is
rate-limited; use a custom domain for production distribution. Setup pins
package URLs and checksums at build time, so changing the host or packages
requires rebuilding setup. No Cloudflare credentials are stored in setup.

Setup logs: %LOCALAPPDATA%/ArchAI/RevitSetup/Logs
Import reports: %LOCALAPPDATA%/ArchAI/Revit/Reports
