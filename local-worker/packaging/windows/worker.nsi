; AIPSTER Worker Windows installer: per-user, consent-based, data-preserving.
; Built only by build.py, which passes APP_VERSION, VI_VERSION, BUILD, APPDIR,
; OUTFILE, SIZE_KB and LICENSE defines. No elevation, no service, no driver,
; no firewall rule, no network access. Uninstall preserves the data directory.
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "StrFunc.nsh"
${Using:StrFunc} StrStr

!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif
!ifndef VI_VERSION
  !define VI_VERSION "0.0.0.0"
!endif
!ifndef BUILD
  !define BUILD "0"
!endif
!ifndef APPDIR
  !error "build.py must pass /DAPPDIR=<frozen app dir>"
!endif
!ifndef LICENSE
  !error "build.py must pass /DLICENSE=<Apache LICENSE path>"
!endif
!ifndef OUTFILE
  !define OUTFILE "AIPSTER-Worker-setup.exe"
!endif
!ifndef SIZE_KB
  !define SIZE_KB "0"
!endif

Name "AIPSTER Worker"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\AIPSTER-Worker"
RequestExecutionLevel user
ManifestDPIAware true
SetCompressor /SOLID lzma

VIProductVersion "${VI_VERSION}"
VIAddVersionKey "ProductName" "AIPSTER Worker"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "CompanyName" "AIPSTER"
VIAddVersionKey "FileDescription" "AIPSTER local worker setup"
VIAddVersionKey "FileVersion" "${VI_VERSION}"
VIAddVersionKey "LegalCopyright" "Apache-2.0, see LICENSE"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "AIPSTER Worker ${APP_VERSION} setup"
!define MUI_WELCOMEPAGE_TEXT "This installs the AIPSTER local worker for your user account only. No administrator rights, services, or network ports are used. Your data directory is created on first run and is never deleted by setup or uninstall.$\r$\n$\r$\nThe worker runs simulated (mock) compute on loopback by default and downloads nothing."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "AIPSTER Worker installed"
!define MUI_FINISHPAGE_TEXT "Start it from the Start Menu (AIPSTER Worker). On first run it creates your private data directory, generates an API token, and serves simulated compute on 127.0.0.1:8090. Nothing is shared or paired."
!define MUI_FINISHPAGE_RUN "$INSTDIR\aipster-worker.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start AIPSTER Worker now"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!define MUI_UNFINISHPAGE_TITLE "AIPSTER Worker removed"
!define MUI_UNFINISHPAGE_TEXT "The application was removed. Your data directory was preserved (see the note shown during uninstall)."
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

Section "AIPSTER Worker (required)" Core
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${APPDIR}\*.*"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\AIPSTER-Worker" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\AIPSTER-Worker" "Version" "${APP_VERSION}+build.${BUILD}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPSTER-Worker" \
    "DisplayName" "AIPSTER Worker"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPSTER-Worker" \
    "DisplayVersion" "${APP_VERSION}+build.${BUILD}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPSTER-Worker" \
    "Publisher" "AIPSTER"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPSTER-Worker" \
    "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPSTER-Worker" \
    "DisplayIcon" "$INSTDIR\aipster-worker.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPSTER-Worker" \
    "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPSTER-Worker" \
    "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPSTER-Worker" \
    "NoRepair" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPSTER-Worker" \
    "EstimatedSize" ${SIZE_KB}
  CreateDirectory "$SMPROGRAMS\AIPSTER Worker"
  CreateShortcut "$SMPROGRAMS\AIPSTER Worker\AIPSTER Worker.lnk" \
    "$INSTDIR\aipster-worker.exe" "" "$INSTDIR\aipster-worker.exe" 0
  CreateShortcut "$SMPROGRAMS\AIPSTER Worker\Uninstall.lnk" "$INSTDIR\uninstall.exe"
SectionEnd

Section /o "Start when I log in" Autostart
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AIPSTER-Worker" \
    '"$INSTDIR\aipster-worker.exe"'
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${Core} "The worker, launcher, and licenses. Required."
  !insertmacro MUI_DESCRIPTION_TEXT ${Autostart} "Start the worker automatically when you log in. Optional and OFF by default. A per-user login entry only, not a system service."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Function .onInit
  ; Scripted explicit opt-in: Setup.exe /AUTOSTART=1 (silent or attended).
  ${GetOptions} $CMDLINE "/AUTOSTART=" $0
  ${If} $0 == "1"
    SectionSetFlags ${Autostart} 1
  ${EndIf}
  ; Upgrades default to the previous location; an explicit /D= still wins.
  ReadRegStr $R0 HKCU "Software\AIPSTER-Worker" "InstallDir"
  ${If} $R0 != ""
    StrCmp "$INSTDIR" "$LOCALAPPDATA\Programs\AIPSTER-Worker" 0 +2
      StrCpy $INSTDIR $R0
  ${EndIf}
  ; Refuse to install over a running worker. tasklist output always ends in a
  ; newline, so match the exe name as a substring, never the whole output.
  ; Silent installs cannot prompt, so they abort (exit 2) for scripted callers.
  running_check:
    nsExec::ExecToStack 'tasklist /FI "IMAGENAME eq aipster-worker.exe" /FO CSV /NH'
    Pop $1
    Pop $2
    ${If} $1 == 0
      ${StrStr} $3 $2 "aipster-worker.exe"
      ${If} $3 != ""
        IfSilent silent_abort prompt_user
        prompt_user:
        MessageBox MB_ABORTRETRYIGNORE|MB_ICONEXCLAMATION \
          "AIPSTER Worker is still running. Stop it first, then retry." \
          IDRETRY running_check IDIGNORE install_anyway
        Abort
        silent_abort:
        SetErrorLevel 2
        Abort
      ${EndIf}
    ${EndIf}
  install_anyway:
FunctionEnd

Section "Uninstall"
  ; Safety: only remove a directory that looks like our install.
  IfFileExists "$INSTDIR\dendrite.exe" proceed abort
  abort:
    MessageBox MB_OK|MB_ICONSTOP \
      "Uninstall aborted: $INSTDIR does not look like an AIPSTER Worker install."
    Abort
  proceed:
  DetailPrint "Removing autostart entry, shortcuts, and registry keys..."
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AIPSTER-Worker"
  Delete "$SMPROGRAMS\AIPSTER Worker\AIPSTER Worker.lnk"
  Delete "$SMPROGRAMS\AIPSTER Worker\Uninstall.lnk"
  RMDir "$SMPROGRAMS\AIPSTER Worker"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPSTER-Worker"
  DeleteRegKey HKCU "Software\AIPSTER-Worker"
  DetailPrint "Removing application files from $INSTDIR..."
  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR"
  DetailPrint "Application removed; the data directory was preserved."
  ; The per-user data directory is deliberately preserved.
  IfSilent +2
    MessageBox MB_OK|MB_ICONINFORMATION \
      "Your worker data in %LOCALAPPDATA%\AIPSTER-Worker (config, token, state, logs) was preserved. Delete that folder manually if you want it gone."
SectionEnd
