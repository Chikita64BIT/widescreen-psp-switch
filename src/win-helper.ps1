# Window helper for the server: finds the PPSSPP window, keeps it visible for the
# screen capture, sends hotkeys to it and closes it. Reads one JSON command per
# line on stdin and answers each with one JSON line on stdout.
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WinApi {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder name, int max);

  // Process.MainWindowHandle skips hidden windows, and PPSSPP may run hidden (--hidden).
  public static IntPtr FindMainWindow(uint processId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner != processId) return true;
      var name = new System.Text.StringBuilder(64);
      GetClassName(h, name, name.Capacity);
      if (name.ToString() != "PPSSPPWnd") return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
"@

# Physical pixels, the same coordinates ffmpeg's gdigrab uses.
[void][WinApi]::SetProcessDPIAware()

$HWND_TOPMOST = [IntPtr](-1)
$SWP_NOSIZE = 0x1
$SWP_NOMOVE = 0x2
$SWP_SHOWWINDOW = 0x40
$SW_RESTORE = 9
$WM_CLOSE = 0x0010
$KEYEVENTF_KEYUP = 0x2
# F24: an unbound key, tapped so Windows lets this process bring PPSSPP to the front.
$VK_FOCUS_TAP = 0x87

function Get-MainWindow([int]$processId) {
  $hwnd = [WinApi]::FindMainWindow([uint32]$processId)
  if ($hwnd -ne [IntPtr]::Zero) { return $hwnd }
  # Other windows (the test form in development) fall back to the visible main window.
  try {
    $process = [System.Diagnostics.Process]::GetProcessById($processId)
    $process.Refresh()
    return $process.MainWindowHandle
  } catch {
    return [IntPtr]::Zero
  }
}

function Get-ClientArea([IntPtr]$hwnd) {
  $rect = New-Object WinApi+RECT
  [void][WinApi]::GetClientRect($hwnd, [ref]$rect)
  $origin = New-Object WinApi+POINT
  [void][WinApi]::ClientToScreen($hwnd, [ref]$origin)
  return @{
    ok = $true
    x = $origin.X
    y = $origin.Y
    w = $rect.Right - $rect.Left
    h = $rect.Bottom - $rect.Top
    vx = [WinApi]::GetSystemMetrics(76)
    vy = [WinApi]::GetSystemMetrics(77)
  }
}

function Invoke-Window($command, [IntPtr]$hwnd) {
  if ([WinApi]::IsIconic($hwnd)) { [void][WinApi]::ShowWindow($hwnd, $SW_RESTORE) }
  if ($command.place) {
    # Resize so the client area (the game image) has exactly the requested size,
    # at the top-left of the primary screen, where nothing else covers it.
    $outer = New-Object WinApi+RECT
    $inner = New-Object WinApi+RECT
    [void][WinApi]::GetWindowRect($hwnd, [ref]$outer)
    [void][WinApi]::GetClientRect($hwnd, [ref]$inner)
    $extraW = ($outer.Right - $outer.Left) - ($inner.Right - $inner.Left)
    $extraH = ($outer.Bottom - $outer.Top) - ($inner.Bottom - $inner.Top)
    [void][WinApi]::SetWindowPos($hwnd, $HWND_TOPMOST, 0, 0, [int]$command.width + $extraW, [int]$command.height + $extraH, $SWP_SHOWWINDOW)
  } else {
    [void][WinApi]::SetWindowPos($hwnd, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW)
  }
  return Get-ClientArea $hwnd
}

function Invoke-Key($command, [IntPtr]$hwnd) {
  if ([WinApi]::GetForegroundWindow() -ne $hwnd) {
    [WinApi]::keybd_event($VK_FOCUS_TAP, 0, 0, [UIntPtr]::Zero)
    [WinApi]::keybd_event($VK_FOCUS_TAP, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)
    [void][WinApi]::SetForegroundWindow($hwnd)
  }
  $vk = [byte]$command.vk
  $scan = [byte][WinApi]::MapVirtualKey($vk, 0)
  $flags = if ($command.down) { 0 } else { $KEYEVENTF_KEYUP }
  [WinApi]::keybd_event($vk, $scan, $flags, [UIntPtr]::Zero)
  return @{ ok = $true }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $command = $line | ConvertFrom-Json
    $hwnd = Get-MainWindow ([int]$command.pid)
    if ($hwnd -eq [IntPtr]::Zero -or -not [WinApi]::IsWindow($hwnd)) {
      $result = @{ ok = $false; error = "no-window" }
    } elseif ($command.cmd -eq "window") {
      $result = Invoke-Window $command $hwnd
    } elseif ($command.cmd -eq "key") {
      $result = Invoke-Key $command $hwnd
    } elseif ($command.cmd -eq "close") {
      [void][WinApi]::PostMessage($hwnd, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
      $result = @{ ok = $true }
    } else {
      $result = @{ ok = $false; error = "unknown-command" }
    }
  } catch {
    $result = @{ ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
