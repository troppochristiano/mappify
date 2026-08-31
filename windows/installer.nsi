; The Windows installer — and the only way a download can arrive with an icon.
;
; A .lnk stores its icon as an absolute path, and Explorer will not resolve a
; link merely to draw one: a shortcut built on a CI runner names a path that does
; not exist on the machine that unzipped it, so it draws blank. Relative icon
; paths do not resolve either. Both were measured rather than assumed, and there
; is no arrangement of a zip and a .lnk that avoids it.
;
; An installer sidesteps the whole problem by creating the shortcut *on the
; user's machine*, where every path it writes is real. It also gives the download
; itself an icon — the setup .exe carries one, which a .zip cannot — and brings
; an uninstaller and an Add/Remove Programs entry that the zip never had.
;
; Per-user, into %LOCALAPPDATA%\Programs: no administrator, no UAC prompt, and no
; writing to Program Files, which the app could not do anyway — it would be
; read-only to everything but an installer, and the data directory logic in
; server/db.js exists because of exactly that.
;
; Every path is passed in as an absolute one, and has to be: makensis resolves a
; relative path against the directory of the .nsi file rather than the working
; directory, so a path like web\public\favicon.ico is looked for under
; windows/ and the build fails with "can't open file" on a file that is there.
;
; Built by .github/workflows/release.yml, which passes every path in:
;   makensis /DVERSION=.. /DPAYLOAD=out\Mappify /DICON=.. /DOUTFILE=.. installer.nsi

Unicode true
!include "MUI2.nsh"

!define APP "Mappify"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"

Name "${APP}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "Software\${APP}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${APP} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "FileDescription" "${APP} - a globe of your music"
VIAddVersionKey "FileVersion" "${VERSION}"

; The globe, on the installer and the uninstaller both.
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"

!define MUI_FINISHPAGE_RUN "$INSTDIR\runtime\node.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "tools\start.js"
!define MUI_FINISHPAGE_RUN_TEXT "Open Mappify"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  ; Sets the working directory recorded in every shortcut created below, which
  ; is what lets the target be started with a relative script path.
  SetOutPath "$INSTDIR"
  ; The zip's own shortcut is not installed: this section writes a better one,
  ; with paths that exist.
  File /r /x "Mappify.lnk" "${PAYLOAD}\*.*"

  CreateShortCut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\runtime\node.exe" "tools\start.js" "$INSTDIR\resources\Mappify.ico" 0 SW_SHOWMINNOACTIVE "" "${APP} - a globe of your music"
  CreateShortCut "$DESKTOP\${APP}.lnk" "$INSTDIR\runtime\node.exe" "tools\start.js" "$INSTDIR\resources\Mappify.ico" 0 SW_SHOWMINNOACTIVE "" "${APP} - a globe of your music"

  WriteRegStr HKCU "Software\${APP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REGKEY}" "DisplayIcon" "$INSTDIR\resources\Mappify.ico"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  ; The library is deliberately left alone. It lives in %APPDATA%\Mappify, it is
  ; the user's own data, and an uninstaller that silently deletes a music library
  ; someone spent twenty minutes importing is not a tidy uninstaller.
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${REGKEY}"
  DeleteRegKey HKCU "Software\${APP}"
SectionEnd
