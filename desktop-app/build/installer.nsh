; Custom NSIS hooks, merged into electron-builder's generated installer via
; electron-builder.js's nsis.include option. Adds Windows Explorer's
; right-click "Beam this file" entry, and removes it again on uninstall --
; a context-menu entry that survives uninstall is a real, common bug with
; this exact pattern, hence the explicit customUnInstall below rather than
; trusting the uninstaller's default file/registry cleanup to catch it.
;
; HKCU (not HKLM) throughout: this installer runs per-user, unsigned, with
; no admin elevation (see ../SIGNING.md) -- HKLM\Software\Classes would
; need admin rights this install never has. HKCU\Software\Classes is the
; correct per-user equivalent Explorer merges into the same context menu.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\*\shell\BeamThisFile" "" "Beam this file"
  WriteRegStr HKCU "Software\Classes\*\shell\BeamThisFile" "Icon" "$INSTDIR\Beam.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\BeamThisFile\command" "" '"$INSTDIR\Beam.exe" --send "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\*\shell\BeamThisFile"
!macroend
