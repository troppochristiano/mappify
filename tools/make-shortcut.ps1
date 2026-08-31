# Writes the shortcut that Windows users double-click.
#
# It replaces a compiled launcher, which is why the relative path matters: a .lnk
# records where its target was when it was made — a path on a CI runner — and the
# person who unzips it has it somewhere else entirely. Setting the relative path
# as well gives the shell the fallback it repairs both the target and the working
# directory from, so the same file works wherever the folder lands.
#
# WScript.Shell cannot write that half, so this drives IShellLinkW directly. The
# COM work is all in C# because PowerShell's cast operator does not
# QueryInterface, and the coclass has to be cast where the compiler can do it.
param(
  [Parameter(Mandatory)][string]$Lnk,
  [Parameter(Mandatory)][string]$Target,
  [string]$Arguments = '',
  [string]$WorkDir = '',
  [string]$Description = '',
  # Defaults to the target, which is how this behaved before there was an icon
  # to point at: node.exe carries its own.
  [string]$Icon = '',
  [int]$ShowCmd = 1
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
public class ShellLinkObj { }

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int cch, IntPtr pfd, uint flags);
  void GetIDList(out IntPtr ppidl);
  void SetIDList(IntPtr pidl);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder n, int cch);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string n);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder d, int cch);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string d);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder a, int cch);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a);
  void GetHotkey(out short k);
  void SetHotkey(short k);
  void GetShowCmd(out int c);
  void SetShowCmd(int c);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int cch, out int i);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p, int i);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string rel, uint reserved);
  void Resolve(IntPtr hwnd, uint flags);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string f);
}

[ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPersistFile {
  void GetClassID(out Guid id);
  [PreserveSig] int IsDirty();
  void Load([MarshalAs(UnmanagedType.LPWStr)] string f, uint mode);
  void Save([MarshalAs(UnmanagedType.LPWStr)] string f, [MarshalAs(UnmanagedType.Bool)] bool remember);
  void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string f);
  void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string f);
}

public static class Shortcut {
  public static void Create(string lnk, string target, string args, string workDir, string desc, int showCmd, string icon) {
    var obj = new ShellLinkObj();
    var link = (IShellLinkW)obj;
    link.SetPath(target);
    if (!string.IsNullOrEmpty(args)) link.SetArguments(args);
    if (!string.IsNullOrEmpty(workDir)) link.SetWorkingDirectory(workDir);
    if (!string.IsNullOrEmpty(desc)) link.SetDescription(desc);
    link.SetShowCmd(showCmd);
    // Before the icon, not after. Setting the relative path last discards the
    // icon location that was set before it — the link saves with a blank icon
    // and no error, which is a thing you can only find by rendering the icon the
    // shell actually draws and looking at the pixels.
    //
    // The relative path is what the shell repairs the target and working
    // directory from once the zip has been unpacked somewhere new.
    link.SetRelativePath(lnk, 0);
    // Absolute, because that is all the icon field can hold — nothing repairs
    // it, which is why tools/start.js rewrites this on first launch.
    link.SetIconLocation(string.IsNullOrEmpty(icon) ? target : icon, 0);
    ((IPersistFile)obj).Save(lnk, true);
  }
}
'@

$lnkPath = [System.IO.Path]::GetFullPath($Lnk)
$targetPath = [System.IO.Path]::GetFullPath($Target)
$dir = if ($WorkDir) { [System.IO.Path]::GetFullPath($WorkDir) } else { '' }
$iconPath = if ($Icon) { [System.IO.Path]::GetFullPath($Icon) } else { '' }
[Shortcut]::Create($lnkPath, $targetPath, $Arguments, $dir, $Description, $ShowCmd, $iconPath)
"wrote $lnkPath"
