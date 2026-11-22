Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!define APP "AzurePet"
!define VER "1.12.0"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"

Name "${APP}"
OutFile "AzurePet-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
BrandingText "${APP} ${VER}"
VIProductVersion "${VER}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "FileDescription" "${APP} Installer"
VIAddVersionKey "FileVersion" "${VER}"
VIAddVersionKey "ProductVersion" "${VER}"
VIAddVersionKey "LegalCopyright" "${APP}"

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_BGCOLOR "FFE6EE"
!define MUI_TEXTCOLOR "5B2B3F"
!define MUI_INSTFILESPAGE_COLORS "5B2B3F FFF6F9"
!define MUI_INSTFILESPAGE_PROGRESSBAR "colored"
!define MUI_WELCOMEPAGE_TEXT "Installer ini akan memasang ${APP} di komputer kamu.$\r$\n$\r$\n${APP} menampilkan karakter 3D (.glb) yang berjalan-jalan di desktop.$\r$\n$\r$\nYang akan dibuat:$\r$\n  •  Shortcut di Desktop$\r$\n  •  Shortcut di Start Menu (bisa dicari lewat Search Windows)$\r$\n  •  Uninstaller di Settings > Apps$\r$\n$\r$\nKlik Install untuk melanjutkan."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP}.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Jalankan ${APP} sekarang"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Indonesian"

!macro KillApp
  nsExec::Exec 'taskkill /F /T /IM "${APP}.exe"'
  Pop $0
  Sleep 800
!macroend

Function .onInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "AzurePet membutuhkan Windows 10 atau Windows 11." /SD IDOK
    Abort
  ${EndIf}
FunctionEnd

Section "Install"
  SetShellVarContext current
  !insertmacro KillApp
  ; ---- upgrade from the old name (DesktopPet): keep settings, remove old app ----
  nsExec::Exec 'taskkill /F /T /IM "DesktopPet.exe"'
  Pop $0
  IfFileExists "$APPDATA\${APP}\config.json" oldcfg_done 0
  IfFileExists "$APPDATA\DesktopPet\config.json" 0 oldcfg_done
    CreateDirectory "$APPDATA\${APP}"
    CopyFiles /SILENT "$APPDATA\DesktopPet\config.json" "$APPDATA\${APP}\config.json"
  oldcfg_done:
  IfFileExists "$LOCALAPPDATA\Programs\DesktopPet\Uninstall.exe" 0 old_done
    ExecWait '"$LOCALAPPDATA\Programs\DesktopPet\Uninstall.exe" /S _?=$LOCALAPPDATA\Programs\DesktopPet'
    RMDir /r "$LOCALAPPDATA\Programs\DesktopPet"
  old_done:
  RMDir /r "$INSTDIR\resources"
  SetOutPath "$INSTDIR"
  File /r "win\*.*"
  File "icon.ico"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortCut "$DESKTOP\${APP}.lnk" "$INSTDIR\${APP}.exe" "" "$INSTDIR\icon.ico" 0
  CreateDirectory "$SMPROGRAMS\${APP}"
  CreateShortCut "$SMPROGRAMS\${APP}\${APP}.lnk" "$INSTDIR\${APP}.exe" "" "$INSTDIR\icon.ico" 0
  CreateShortCut "$SMPROGRAMS\${APP}\Uninstall ${APP}.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNKEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${VER}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "${APP}"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNKEY}" "EstimatedSize" 215000
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  !insertmacro KillApp
  Delete "$DESKTOP\${APP}.lnk"
  RMDir /r "$SMPROGRAMS\${APP}"
  DeleteRegKey HKCU "${UNKEY}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.${APP}"
  ; only remove the folder if it really is our install folder
  IfFileExists "$INSTDIR\${APP}.exe" 0 +2
    RMDir /r "$INSTDIR"
  RMDir /r "$APPDATA\${APP}"
SectionEnd
