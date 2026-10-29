; AIPSTER Worker Windows installer: per-user, consent-based, tray-first.
; Built only by build.py, which passes APP_VERSION, VI_VERSION, BUILD, APPDIR,
; OUTFILE, SIZE_KB and LICENSE defines. No elevation, no service, no driver,
; no firewall rule, no network access. Shortcuts launch the windowed tray app
; (no console). Uninstall preserves the data directory unless the user checks
; the removal box (or passes /REMOVEDATA=1); a custom AIPSTER_WORKER_DATA
; folder is never touched.
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "StrFunc.nsh"
!include "nsDialogs.nsh"
${Using:StrFunc} StrStr

Var RemoveData

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
!define MUI_WELCOMEPAGE_TEXT "This installs the AIPSTER local worker for your user account only. No administrator rights, services, or network ports are used. The worker runs in the system tray (no console window) and serves simulated (mock) compute on loopback by default; it downloads nothing.$\r$\n$\r$\nYour data directory is created on first run and is preserved by uninstall unless you choose otherwise."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "AIPSTER Worker installed"
!define MUI_FINISHPAGE_TEXT "Start it from the Start Menu or desktop shortcut (AIPSTER Worker). It runs in the system tray: on first run it creates your private data directory, generates an API token, and serves simulated compute on 127.0.0.1:8090. Nothing is shared or paired."
!define MUI_FINISHPAGE_RUN "$INSTDIR\aipster-tray.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start AIPSTER Worker now"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.DataChoice un.DataChoiceLeave
!insertmacro MUI_UNPAGE_INSTFILES
!define MUI_UNFINISHPAGE_TITLE "AIPSTER Worker removed"
!define MUI_UNFINISHPAGE_TEXT "The application was removed."
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
    "DisplayIcon" "$INSTDIR\aipster-tray.exe"
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
    "$INSTDIR\aipster-tray.exe" "" "$INSTDIR\aipster-tray.exe" 0
  CreateShortcut "$SMPROGRAMS\AIPSTER Worker\Uninstall.lnk" "$INSTDIR\uninstall.exe"
SectionEnd

Section "Desktop shortcut" Desktop
  CreateShortcut "$DESKTOP\AIPSTER Worker.lnk" \
    "$INSTDIR\aipster-tray.exe" "" "$INSTDIR\aipster-tray.exe" 0
SectionEnd

Section /o "Start when I log in" Autostart
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "AIPSTER-Worker" \
    '"$INSTDIR\aipster-tray.exe"'
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${Core} "The worker, tray app, launcher, and licenses. Required."
  !insertmacro MUI_DESCRIPTION_TEXT ${Desktop} "A desktop shortcut to the tray app. Uncheck to skip it."
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
  ; Refuse to install over running worker processes (tray, console launcher,
  ; or raw CLI). Each tasklist call is filtered to one image: NSIS strings
  ; truncate at 1023 chars, so an unfiltered process list would hide
  ; workers. tasklist output always ends in a newline, so match exe names
  ; as substrings, never the whole output. Silent installs abort (exit 2).
  running_check:
    StrCpy $4 ""
    nsExec::ExecToStack 'tasklist /FO CSV /NH /FI "IMAGENAME eq aipster-tray.exe"'
    Pop $1
    Pop $2
    ${If} $1 == 0
      ${StrStr} $3 $2 "aipster-tray.exe"
      ${If} $3 != ""
        StrCpy $4 "aipster-tray.exe"
      ${EndIf}
    ${EndIf}
    ${If} $4 == ""
      nsExec::ExecToStack 'tasklist /FO CSV /NH /FI "IMAGENAME eq aipster-worker.exe"'
      Pop $1
      Pop $2
      ${If} $1 == 0
        ${StrStr} $3 $2 "aipster-worker.exe"
        ${If} $3 != ""
          StrCpy $4 "aipster-worker.exe"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $4 == ""
      nsExec::ExecToStack 'tasklist /FO CSV /NH /FI "IMAGENAME eq dendrite.exe"'
      Pop $1
      Pop $2
      ${If} $1 == 0
        ${StrStr} $3 $2 "dendrite.exe"
        ${If} $3 != ""
          StrCpy $4 "dendrite.exe"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $4 != ""
      IfSilent silent_abort prompt_user
      prompt_user:
      MessageBox MB_ABORTRETRYIGNORE|MB_ICONEXCLAMATION \
        "AIPSTER Worker ($4) is still running. Stop it first (tray menu Quit or Ctrl+C), then retry." \
        IDRETRY running_check IDIGNORE install_anyway
      Abort
      silent_abort:
      SetErrorLevel 2
      Abort
    ${EndIf}
  install_anyway:
FunctionEnd

Function un.onInit
  StrCpy $RemoveData 0
  ; Scripted explicit data removal: uninstall.exe /S /REMOVEDATA=1.
  ${GetOptions} $CMDLINE "/REMOVEDATA=" $0
  ${If} $0 == "1"
    StrCpy $RemoveData 1
  ${EndIf}
FunctionEnd

Function un.DataChoice
  ${If} $RemoveData == 1
    Abort ; scripted choice: skip the page, keep removal
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Remove data?" "Choose whether your private worker data goes too."
  ${NSD_CreateLabel} 0 0 100% 24u "The application files, shortcuts, and settings are always removed. Your data directory holds your config, API token, state, and logs."
  Pop $0
  ${NSD_CreateCheckbox} 0 34u 100% 12u "Also remove my worker data in %LOCALAPPDATA%\AIPSTER-Worker"
  Pop $1
  nsDialogs::Show
FunctionEnd

Function un.DataChoiceLeave
  ${NSD_GetState} $1 $RemoveData
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
  Delete "$DESKTOP\AIPSTER Worker.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPSTER-Worker"
  DeleteRegKey HKCU "Software\AIPSTER-Worker"
  DetailPrint "Removing application files from $INSTDIR..."
  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR"
  ${If} $RemoveData == 1
    DetailPrint "Removing the default data directory as chosen..."
    RMDir /r "$LOCALAPPDATA\AIPSTER-Worker"
    DetailPrint "Application and default data directory removed."
    IfSilent +2
      MessageBox MB_OK|MB_ICONINFORMATION \
        "The application and your worker data in %LOCALAPPDATA%\AIPSTER-Worker were removed."
  ${Else}
    DetailPrint "Application removed; the data directory was preserved."
    IfSilent +2
      MessageBox MB_OK|MB_ICONINFORMATION \
        "Your worker data in %LOCALAPPDATA%\AIPSTER-Worker (config, token, state, logs) was preserved. Delete that folder manually if you want it gone."
  ${EndIf}
SectionEnd
