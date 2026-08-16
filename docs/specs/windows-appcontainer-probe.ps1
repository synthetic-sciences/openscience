<#
.SYNOPSIS
  Measures what an AppContainer with NO capabilities can actually do on this
  machine, unelevated.

.DESCRIPTION
  docs/specs/windows-sandbox-design.md proposes running the agent in an
  AppContainer with no network capability, reaching approved hosts only through
  a broker over a named pipe. This probe measures the transport chain that
  design depends on, end to end:

      pip --(loopback)--> shim --(named pipe)--> broker --> network

  Every hop, and every join between hops, is measured rather than reasoned.

  SECTIONS
    0. Host enforcement context. AppContainer network isolation is a WFP policy
       enforced by MpsSvc. With that service stopped or displaced by
       third-party filtering, a NO on the network tests is a fact about the
       machine, not about the design. Read this first or the rest is noise.
    1. Profile creation, unelevated.
    2. Child launch, with a fallback ladder so that a marshalling bug in THIS
       SCRIPT can never be mistaken for the sandbox refusing to start a process.
    3. Single-process battery: loopback, outbound, host loopback, pipe open,
       DNS, filesystem, environment.
    4. Two-process loopback. A single process connecting to itself proves the
       socket stack works; it does NOT prove that a shim in one process can
       serve pip in another. Same package SID, two live processes, real bytes.
    5. Sustained bidirectional pipe traffic. Opening a handle is not a
       transport. 64 KiB each way, interleaved, checksum verified.

  CONTROLS, because a bare YES/NO is not evidence:
    - a second named pipe with the DEFAULT DACL. If the granted pipe opens and
      the default one does not, the package-SID grant is demonstrably what did
      the work. If BOTH open, the grant is not what is being tested.
    - a DNS positive control (a name that unquestionably resolves). A resolver
      that refuses an AppContainer token reports WSAHOST_NOT_FOUND, the same
      code as a genuine NXDOMAIN. The uncacheable probe carries NO information
      unless the control passes first.
    - System32 readability, as a positive control for the filesystem tests: if
      even that fails, the filesystem results are measuring something else.
    - every failed connect records its Winsock error code. WSAEACCES (10013)
      means isolation actively refused. A timeout means the packet was dropped
      silently - a different mechanism, and worth distinguishing.

  Nothing here installs anything, needs a compiler, or touches the network
  except to attempt one outbound connection that is EXPECTED to fail.

  ENCODING: this file is deliberately pure ASCII. Windows PowerShell 5.1 reads
  BOM-less .ps1 files as ANSI; a UTF-8 em dash decodes to bytes containing
  U+201D, which the 5.1 tokenizer accepts as a string delimiter, and the file
  then fails to parse hundreds of lines away from the real problem. Keep it
  ASCII. Do not paste in typographic dashes or curly quotes.

.PARAMETER Name
  AppContainer profile name. Reused if it already exists; deleted on exit
  unless -Keep is passed.

.PARAMETER Keep
  Leave the profile and temp directory behind for inspection.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\windows-appcontainer-probe.ps1
#>
[CmdletBinding()]
param(
  [string] $Name = "openscience-probe",
  [switch] $Keep
)

$ErrorActionPreference = "Stop"

function Say([string] $text, [string] $colour = "Gray") { Write-Host $text -ForegroundColor $colour }

function Result([string] $label, [bool] $value, [string] $expected, [string] $note = "") {
  $mark = if ($value) { "YES" } else { "NO " }
  $colour = if ($expected -eq "either") { "Cyan" } elseif (($expected -eq "yes") -eq $value) { "Green" } else { "Red" }
  Say ("  {0,-52} {1}" -f $label, $mark) $colour
  if ($note) { Say ("  {0,-52}     {1}" -f "", $note) "DarkGray" }
}

# -- Elevation ---------------------------------------------------------------
# The entire premise of the design is that OpenScience never asks for admin.
# A probe run elevated would answer a question nobody asked.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$elevated = ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

Say ""
Say "OpenScience - Windows AppContainer probe" "White"
Say ("  user            : {0}" -f $identity.Name)
Say ("  elevated        : {0}" -f $elevated) $(if ($elevated) { "Yellow" } else { "Green" })
Say ("  windows         : {0}" -f [Environment]::OSVersion.Version)
Say ("  powershell      : {0}" -f $PSVersionTable.PSVersion)
Say ("  clr             : {0}" -f [Environment]::Version)
if ($elevated) {
  Say ""
  Say "  WARNING: running elevated. The design's whole claim is that none of" "Yellow"
  Say "  this needs admin, so re-run in a NORMAL terminal for a valid answer." "Yellow"
}
Say ""

# -- 0. Host enforcement context ---------------------------------------------
Say "0. Host enforcement context (results below are meaningless without this)" "White"

$hostContext = @{}

try {
  $mps = Get-Service -Name MpsSvc -ErrorAction Stop
  $hostContext.mpsSvcStatus = $mps.Status.ToString()
  $ok = ($mps.Status -eq 'Running')
  Result "Windows Firewall service (MpsSvc) running" $ok "yes"
  if (-not $ok) {
    Say "  AppContainer network isolation is enforced here. With it stopped," "Red"
    Say "  a NO on the outbound tests below proves nothing." "Red"
  }
} catch {
  $hostContext.mpsSvcStatus = "query failed: " + $_.Exception.Message
  Result "Windows Firewall service (MpsSvc) running" $false "yes" "could not query"
}

try {
  $profiles = Get-NetFirewallProfile -ErrorAction Stop | Select-Object -Property Name, Enabled
  $hostContext.firewallProfiles = @{}
  foreach ($p in $profiles) { $hostContext.firewallProfiles[$p.Name.ToString()] = [bool]$p.Enabled }
  $allOn = -not ($profiles | Where-Object { -not $_.Enabled })
  Result "all firewall profiles enabled" ([bool]$allOn) "yes" (
    ($profiles | ForEach-Object { "{0}={1}" -f $_.Name, $_.Enabled }) -join "  ")
} catch {
  $hostContext.firewallProfiles = "query failed: " + $_.Exception.Message
  Say "  (Get-NetFirewallProfile unavailable; may need the NetSecurity module)" "DarkGray"
}

# Pre-existing loopback exemptions are set machine-wide by Visual Studio, Edge
# dev tooling and various installers. If our package inherited one, the
# host-loopback result would be measuring somebody else's configuration.
try {
  $exempt = (& CheckNetIsolation.exe LoopbackExempt -s 2>&1) -join "`n"
  $hostContext.loopbackExempt = $exempt
  $exemptCount = ([regex]::Matches($exempt, 'S-1-15-2-')).Count
  $hostContext.loopbackExemptCount = $exemptCount
  Say ("  existing loopback exemptions on this machine : {0}" -f $exemptCount) $(
    if ($exemptCount -gt 0) { "Yellow" } else { "Gray" })
} catch {
  $hostContext.loopbackExempt = "CheckNetIsolation unavailable: " + $_.Exception.Message
  $hostContext.loopbackExemptCount = -1
}

try {
  $av = Get-CimInstance -Namespace root\SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop |
    Select-Object -ExpandProperty displayName
  $hostContext.securityProducts = @($av)
  if ($av) { Say ("  security products: {0}" -f (@($av) -join ", ")) "DarkGray" }
} catch { $hostContext.securityProducts = "not queryable" }

# DNS positive control, measured on the HOST. If pypi.org does not resolve out
# here either, the container's DNS result says nothing about the container.
$hostDnsOk = $false
try {
  [Net.Dns]::GetHostAddresses('pypi.org') | Out-Null
  $hostDnsOk = $true
} catch { $hostContext.hostDnsError = $_.Exception.Message }
$hostContext.hostDnsResolves = $hostDnsOk
Result "HOST can resolve pypi.org (DNS control)" $hostDnsOk "yes" (
  $(if (-not $hostDnsOk) { "host DNS is down - container DNS result will be uninterpretable" } else { "" }))

Say ""

# -- Win32 interop -----------------------------------------------------------
# Inline C# rather than raw PowerShell marshalling. Two reasons: an
# UpdateProcThreadAttribute SECURITY_CAPABILITIES blob is where a
# hand-marshalled version goes subtly wrong and reports a false negative; and
# the pipe echo server needs a real background thread doing blocking I/O, which
# is far more reliable in C# than in a PowerShell runspace.
if (-not ("OpenScience.AppContainer" -as [type])) {
  Add-Type -Language CSharp -ReferencedAssemblies @("System.dll", "System.Core.dll") -TypeDefinition @"
using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace OpenScience {
  [StructLayout(LayoutKind.Sequential)]
  public struct SecurityCapabilities {
    public IntPtr AppContainerSid;
    public IntPtr Capabilities;
    public uint CapabilityCount;
    public uint Reserved;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct StartupInfoEx {
    public int cb; public IntPtr lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError, lpAttributeList;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct ProcessInformation { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  /// A live child. Kept open so two children can run in the same container at
  /// once, which is the only way to ask whether a shim in one process can
  /// serve a client in another.
  public class ProcHandle {
    public IntPtr Process = IntPtr.Zero;
    public IntPtr Thread = IntPtr.Zero;
    public int Pid;
    public bool Started;
    public int Win32Error;
    public string Stage = "";
  }

  public class LaunchResult {
    public bool Started;
    public bool TimedOut;
    public int ExitCode = -2;
    public int Win32Error;
    public int PreviousWin32Error;
    public int Pid;
    public string Stage = "";
  }

  /// A named pipe server that echoes everything it receives, on a background
  /// thread. Opening a pipe handle is not a transport; a proxy tunnel needs
  /// sustained traffic in both directions, and only a server that actually
  /// reads and writes can demonstrate that.
  public class PipeEcho {
    public string Name;
    public volatile bool Connected;
    public long BytesEchoed;
    public string Error = "";
    NamedPipeServerStream srv;
    Thread worker;
    volatile bool stop;

    /// An empty or null packageSid builds the pipe with the DEFAULT DACL. That
    /// is the control: it must NOT be openable from the container. Supplying a
    /// PipeSecurity REPLACES the default DACL entirely, so the creating user
    /// has to be granted explicitly or the server cannot use its own pipe.
    ///
    /// The emptiness check is IsNullOrEmpty, not == null, because PowerShell
    /// converts $null to "" when binding to a string parameter. A plain null
    /// check therefore falls through to new SecurityIdentifier(""), which
    /// throws ArgumentException naming 'sddlForm' - an error that looks like a
    /// bad SID rather than a bad control setup.
    public static PipeEcho Start(string name, string packageSid) {
      PipeEcho e = new PipeEcho();
      e.Name = name;
      if (string.IsNullOrEmpty(packageSid)) {
        e.srv = new NamedPipeServerStream(name, PipeDirection.InOut, 1,
          PipeTransmissionMode.Byte, PipeOptions.None, 65536, 65536);
      } else {
        PipeSecurity sec = new PipeSecurity();
        sec.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,
          PipeAccessRights.FullControl, AccessControlType.Allow));
        sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(packageSid),
          PipeAccessRights.ReadWrite, AccessControlType.Allow));
        e.srv = new NamedPipeServerStream(name, PipeDirection.InOut, 1,
          PipeTransmissionMode.Byte, PipeOptions.None, 65536, 65536, sec);
      }
      e.worker = new Thread(new ThreadStart(e.Run));
      e.worker.IsBackground = true;
      e.worker.Start();
      return e;
    }

    void Run() {
      try {
        srv.WaitForConnection();
        Connected = true;
        byte[] buf = new byte[16384];
        while (!stop) {
          int n = srv.Read(buf, 0, buf.Length);
          if (n <= 0) break;
          srv.Write(buf, 0, n);
          srv.Flush();
          BytesEchoed += n;
        }
      } catch (Exception ex) {
        if (!stop) Error = ex.Message;
      }
    }

    public void Stop() {
      stop = true;
      try { if (srv != null) srv.Dispose(); } catch { }
      try { if (worker != null) worker.Join(1000); } catch { }
    }
  }

  public static class AppContainer {
    const uint EXTENDED_STARTUPINFO_PRESENT  = 0x00080000;
    const uint CREATE_NO_WINDOW              = 0x08000000;
    const uint CREATE_UNICODE_ENVIRONMENT    = 0x00000400;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = (IntPtr)0x00020009;

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int CreateAppContainerProfile(string name, string display, string description,
      IntPtr capabilities, uint capabilityCount, out IntPtr sid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int DeleteAppContainerProfile(string name);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSidToSid(string str, out IntPtr sid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr LocalFree(IntPtr p);

    // FreeSid is exported by advapi32.dll, NOT userenv.dll. userenv exports the
    // functions that HAND you the SID, which is what makes the wrong DLL an
    // easy mistake - and getting it wrong throws from a finally block AFTER
    // the profile was created, so the failure reads as "creation failed".
    [DllImport("advapi32.dll")]
    static extern IntPtr FreeSid(IntPtr sid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
      IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern void DeleteProcThreadAttributeList(IntPtr list);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder commandLine,
      IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
      IntPtr environment, string currentDirectory, ref StartupInfoEx startupInfo, out ProcessInformation info);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr handle, out uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr handle, uint code);

    static string SidToString(IntPtr sid) {
      IntPtr str;
      if (!ConvertSidToStringSid(sid, out str)) throw new Win32Exception(Marshal.GetLastWin32Error());
      try { return Marshal.PtrToStringUni(str); } finally { LocalFree(str); }
    }

    public static string EnsureProfile(string name, out bool created, out int hresult) {
      IntPtr sid;
      hresult = CreateAppContainerProfile(name, name, "OpenScience sandbox probe", IntPtr.Zero, 0, out sid);
      created = (hresult == 0);
      if (hresult == 0) { try { return SidToString(sid); } finally { FreeSid(sid); } }
      // 0x800700B7 == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)
      if ((uint)hresult == 0x800700B7) {
        int derived = DeriveAppContainerSidFromAppContainerName(name, out sid);
        if (derived != 0) throw new Win32Exception(derived, "DeriveAppContainerSidFromAppContainerName failed");
        try { return SidToString(sid); } finally { FreeSid(sid); }
      }
      throw new Win32Exception(hresult, "CreateAppContainerProfile failed (HRESULT 0x" + hresult.ToString("X8") + ")");
    }

    public static void Delete(string name) { DeleteAppContainerProfile(name); }

    /// "K=V" entries -> a double-null-terminated Unicode environment block.
    ///
    /// Explicit char copy rather than StringToHGlobalUni: the latter's handling
    /// of embedded nulls is the kind of detail easier to sidestep than to
    /// verify. An empty entry, or one with no '=', corrupts the block and
    /// CreateProcess answers ERROR_ENVVAR_NOT_FOUND (203) - a failure that
    /// reads like "the sandbox refused to start the child" when the child was
    /// simply never given a valid environment.
    static IntPtr BuildEnvironmentBlock(string[] entries) {
      if (entries == null || entries.Length == 0) return IntPtr.Zero;
      StringBuilder sb = new StringBuilder();
      int kept = 0;
      foreach (string e in entries) {
        if (string.IsNullOrEmpty(e)) continue;
        if (e.IndexOf('=') <= 0) continue;
        if (e.IndexOf('\0') >= 0) continue;
        sb.Append(e); sb.Append('\0');
        kept++;
      }
      if (kept == 0) return IntPtr.Zero;
      sb.Append('\0');
      char[] chars = sb.ToString().ToCharArray();
      IntPtr block = Marshal.AllocHGlobal(chars.Length * sizeof(char));
      Marshal.Copy(chars, 0, block, chars.Length);
      return block;
    }

    /// Starts a child in the AppContainer and RETURNS WITHOUT WAITING.
    /// Does not throw on CreateProcess failure: an out-parameter written before
    /// a throw is discarded when the exception crosses back into PowerShell,
    /// losing the error code exactly when it matters.
    public static ProcHandle Start(string sidString, string commandLine, string workingDirectory,
                                   string[] environment) {
      ProcHandle h = new ProcHandle();
      IntPtr sid;
      if (!ConvertStringSidToSid(sidString, out sid)) throw new Win32Exception(Marshal.GetLastWin32Error());

      IntPtr attributes = IntPtr.Zero;
      IntPtr capabilitiesBlob = IntPtr.Zero;
      IntPtr envBlock = IntPtr.Zero;
      try {
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        attributes = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList failed");

        // CapabilityCount 0 is the whole point: no internetClient, no
        // privateNetworkClientServer, nothing.
        SecurityCapabilities caps = new SecurityCapabilities();
        caps.AppContainerSid = sid;
        caps.Capabilities = IntPtr.Zero;
        caps.CapabilityCount = 0;
        caps.Reserved = 0;

        capabilitiesBlob = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityCapabilities)));
        Marshal.StructureToPtr(caps, capabilitiesBlob, false);

        if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
              capabilitiesBlob, (IntPtr)Marshal.SizeOf(typeof(SecurityCapabilities)), IntPtr.Zero, IntPtr.Zero))
          throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateProcThreadAttribute failed");

        StartupInfoEx si = new StartupInfoEx();
        si.cb = Marshal.SizeOf(typeof(StartupInfoEx));
        si.lpAttributeList = attributes;

        envBlock = BuildEnvironmentBlock(environment);
        uint flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW;
        if (envBlock != IntPtr.Zero) flags |= CREATE_UNICODE_ENVIRONMENT;

        ProcessInformation pi;
        StringBuilder cmd = new StringBuilder(commandLine);
        if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false,
              flags, envBlock, workingDirectory, ref si, out pi)) {
          h.Started = false;
          h.Win32Error = Marshal.GetLastWin32Error();
          return h;
        }
        h.Started = true;
        h.Process = pi.hProcess;
        h.Thread = pi.hThread;
        h.Pid = pi.dwProcessId;
        return h;
      } finally {
        if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
        if (capabilitiesBlob != IntPtr.Zero) Marshal.FreeHGlobal(capabilitiesBlob);
        if (envBlock != IntPtr.Zero) Marshal.FreeHGlobal(envBlock);
        if (sid != IntPtr.Zero) LocalFree(sid);
      }
    }

    public static LaunchResult Wait(ProcHandle h, int timeoutMs) {
      LaunchResult r = new LaunchResult();
      r.Started = h.Started;
      r.Win32Error = h.Win32Error;
      r.Stage = h.Stage;
      r.Pid = h.Pid;
      if (!h.Started) return r;
      try {
        if (WaitForSingleObject(h.Process, (uint)timeoutMs) != 0) {
          TerminateProcess(h.Process, 9999);
          r.TimedOut = true;
          r.ExitCode = -1;
          return r;
        }
        uint code;
        if (!GetExitCodeProcess(h.Process, out code)) throw new Win32Exception(Marshal.GetLastWin32Error());
        r.ExitCode = unchecked((int)code);
        return r;
      } finally {
        if (h.Thread != IntPtr.Zero) CloseHandle(h.Thread);
        if (h.Process != IntPtr.Zero) CloseHandle(h.Process);
        h.Thread = IntPtr.Zero;
        h.Process = IntPtr.Zero;
      }
    }

    public static LaunchResult Launch(string sidString, string commandLine, string workingDirectory,
                                      string[] environment, int timeoutMs) {
      ProcHandle h = Start(sidString, commandLine, workingDirectory, environment);
      return Wait(h, timeoutMs);
    }

    /// Tries progressively less opinionated launch configurations and reports
    /// which one worked. A failure at rung 1 that succeeds at rung 2 is a fact
    /// about THIS SCRIPT's marshalling, NOT about AppContainers - and a
    /// single-shot version cannot tell those apart.
    public static LaunchResult LaunchWithFallback(string sidString, string commandLine,
                                                  string workingDirectory, string[] environment, int timeoutMs) {
      LaunchResult r = Launch(sidString, commandLine, workingDirectory, environment, timeoutMs);
      r.Stage = "explicit env + explicit cwd";
      if (r.Started) return r;
      int first = r.Win32Error;

      r = Launch(sidString, commandLine, workingDirectory, null, timeoutMs);
      r.Stage = "inherited env + explicit cwd";
      r.PreviousWin32Error = first;
      if (r.Started) return r;

      int second = r.Win32Error;
      r = Launch(sidString, commandLine, null, null, timeoutMs);
      r.Stage = "inherited env + inherited cwd";
      r.PreviousWin32Error = (first != 0 ? first : second);
      return r;
    }
  }
}
"@
}

# -- 1. Create the profile, unelevated ---------------------------------------
Say "1. CreateAppContainerProfile as a standard user" "White"
$created = $false
$hr = 0
try {
  $sid = [OpenScience.AppContainer]::EnsureProfile($Name, [ref]$created, [ref]$hr)
} catch {
  Say ("  FAILED: {0}" -f $_.Exception.Message) "Red"
  Say ""
  Say "  Question 1 answered: NO - the design's foundation does not hold." "Red"
  Say "  Everything downstream of it is moot; send this output back." "Red"
  exit 1
}
Result "profile created or already present" $true "yes"
Say ("  SID             : {0}" -f $sid) "Gray"
Say ("  newly created   : {0}" -f $created) "Gray"
Say ""

# -- Scratch dir the container can write -------------------------------------
$work = Join-Path ([IO.Path]::GetTempPath()) ("openscience-probe-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
& icacls.exe $work /grant ("*" + $sid + ":(OI)(CI)(F)") /Q | Out-Null
$aclOk = ($LASTEXITCODE -eq 0)
Result "temp dir ACL'd to the package SID (icacls)" $aclOk "yes" $work

$marker = Join-Path $work "started.txt"
$report = Join-Path $work "report.json"
$listenerReport = Join-Path $work "listener.json"
$connectorReport = Join-Path $work "connector.json"
$portFile = Join-Path $work "listener-port.txt"

# -- Host-side channels ------------------------------------------------------
$hostListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$hostListener.Start()
$hostPort = ([Net.IPEndPoint]$hostListener.Server.LocalEndPoint).Port

# Pipe A: DACL grants the package SID, and the server ECHOES. This is the
# design's proposed broker transport.
# Pipe B: default DACL, no grant. The control.
$pipeAcl = "openscience-probe-acl-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
$pipeDefault = "openscience-probe-def-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
$echoAcl = [OpenScience.PipeEcho]::Start($pipeAcl, $sid)
$echoDefault = [OpenScience.PipeEcho]::Start($pipeDefault, '')

Say ("  host loopback listener on 127.0.0.1:{0}" -f $hostPort) "Gray"
Say ("  host echo pipe (package SID granted) : \\.\pipe\{0}" -f $pipeAcl) "Gray"
Say ("  host echo pipe (default DACL, control): \\.\pipe\{0}" -f $pipeDefault) "Gray"

$dnsProbe = ([Guid]::NewGuid().ToString("N")) + ".probe.invalid-openscience.test"
Say ("  uncacheable DNS probe name      : {0}" -f $dnsProbe) "Gray"

# Filesystem probe targets. The read target is this script itself; the write
# target is a path in the user profile that must NOT appear.
$profileRead = $PSCommandPath
$profileWrite = Join-Path $env:USERPROFILE ("openscience-probe-should-not-exist-" +
  [Guid]::NewGuid().ToString("N").Substring(0, 6) + ".txt")
Say ""

# -- Child script ------------------------------------------------------------
# One file, three roles. ErrorActionPreference is Stop with per-test wrapping:
# a blanket SilentlyContinue turns a failed first write into a silent false
# negative on the most basic question in the probe.
#
# Bits start at 64 so "the child ran" can never be confused with PowerShell's
# own generic exit code 1. report.json is authoritative; the exit code is a
# redundant fallback.
$childPath = Join-Path $work "child.ps1"
@"
param([string] `$Role = 'probe')

`$ErrorActionPreference = 'Stop'
`$work         = '$work'
`$hostPort     = $hostPort
`$pipeAcl      = '$pipeAcl'
`$pipeDefault  = '$pipeDefault'
`$dnsProbe     = '$dnsProbe'
`$profileRead  = '$profileRead'
`$profileWrite = '$profileWrite'

function Get-SockErr(`$e) {
  `$se = `$e.Exception
  while (`$se -and -not (`$se -is [Net.Sockets.SocketException])) { `$se = `$se.InnerException }
  if (`$se) { return @{ code = [int]`$se.ErrorCode; name = `$se.SocketErrorCode.ToString(); message = `$se.Message } }
  return @{ code = -1; name = 'NonSocket'; message = `$e.Exception.Message }
}

# Deterministic payload so both ends can verify content, not just byte count.
function New-Payload([int] `$n) {
  `$b = New-Object byte[] `$n
  for (`$i = 0; `$i -lt `$n; `$i++) { `$b[`$i] = [byte](`$i % 251) }
  return `$b
}
function Test-Payload(`$b, [int] `$n) {
  if (`$b.Length -ne `$n) { return `$false }
  for (`$i = 0; `$i -lt `$n; `$i++) { if (`$b[`$i] -ne [byte](`$i % 251)) { return `$false } }
  return `$true
}

# PipeStream does NOT support ReadTimeout: CanTimeout is false for a
# synchronous byte-mode pipe, and assigning it throws. A blocking Read with no
# timeout is not an option either - if the pipe cannot carry data the child
# hangs until the launcher kills it, and report.json is never written, losing
# every OTHER result in the run. BeginRead works on a synchronous handle (the
# framework falls back to the thread pool), so the wait handle supplies the
# timeout. On expiry this throws, which aborts the whole pipe section; the
# stream is then disposed and the abandoned read cannot corrupt anything.
function Read-Timed(`$stream, `$buf, [int] `$offset, [int] `$count, [int] `$ms) {
  `$iar = `$stream.BeginRead(`$buf, `$offset, `$count, `$null, `$null)
  if (-not `$iar.AsyncWaitHandle.WaitOne(`$ms)) { throw ("read timed out after " + `$ms + "ms") }
  return `$stream.EndRead(`$iar)
}

# ============================================================================
# ROLE: listener - one half of the two-process loopback test.
# ============================================================================
if (`$Role -eq 'listener') {
  `$d = @{}
  `$bits = 1
  `$l = `$null
  try {
    `$l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    `$l.Start()
    `$port = ([Net.IPEndPoint]`$l.Server.LocalEndPoint).Port
    `$d.port = `$port
    `$bits = `$bits -bor 2
    # Publishing the port through the shared directory rather than a socket:
    # the connector cannot be told the port over a channel we are still trying
    # to prove exists.
    Set-Content -LiteralPath (Join-Path `$work 'listener-port.txt') -Value `$port

    `$acc = `$l.BeginAcceptTcpClient(`$null, `$null)
    if (`$acc.AsyncWaitHandle.WaitOne(20000)) {
      `$c = `$l.EndAcceptTcpClient(`$acc)
      `$bits = `$bits -bor 4
      `$d.acceptedFrom = `$c.Client.RemoteEndPoint.ToString()
      `$s = `$c.GetStream()
      `$s.ReadTimeout = 8000
      `$buf = New-Object byte[] 4096
      `$total = 0
      # Echo until the peer stops. Proves a full duplex conversation between
      # two processes, not a single accepted connection.
      while (`$total -lt 8192) {
        `$n = `$s.Read(`$buf, 0, `$buf.Length)
        if (`$n -le 0) { break }
        `$s.Write(`$buf, 0, `$n)
        `$s.Flush()
        `$total += `$n
      }
      `$d.echoedBytes = `$total
      if (`$total -ge 8192) { `$bits = `$bits -bor 8 }
      `$c.Close()
    } else { `$d.acceptError = 'no connection within 20s' }
  } catch { `$d.listenerError = (Get-SockErr `$_) }
  finally { if (`$l) { try { `$l.Stop() } catch {} } }
  `$d.bits = `$bits
  try { `$d | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path `$work 'listener.json') } catch {}
  exit `$bits
}

# ============================================================================
# ROLE: connector - the other half. A DIFFERENT process, same package SID.
# ============================================================================
if (`$Role -eq 'connector') {
  `$d = @{}
  `$bits = 1
  try {
    `$pf = Join-Path `$work 'listener-port.txt'
    `$deadline = (Get-Date).AddSeconds(15)
    `$port = `$null
    while ((Get-Date) -lt `$deadline) {
      if (Test-Path -LiteralPath `$pf) {
        `$raw = (Get-Content -LiteralPath `$pf -Raw).Trim()
        if (`$raw) { `$port = [int]`$raw; break }
      }
      Start-Sleep -Milliseconds 200
    }
    if (-not `$port) { throw 'listener never published a port' }
    `$d.port = `$port
    `$bits = `$bits -bor 2

    `$c = [Net.Sockets.TcpClient]::new()
    `$iar = `$c.BeginConnect([Net.IPAddress]::Loopback, `$port, `$null, `$null)
    if (-not `$iar.AsyncWaitHandle.WaitOne(8000)) { throw 'connect timed out' }
    `$c.EndConnect(`$iar)
    `$bits = `$bits -bor 4

    `$s = `$c.GetStream()
    `$s.ReadTimeout = 8000
    `$payload = New-Payload 8192
    `$back = New-Object byte[] 8192
    `$sent = 0; `$got = 0
    # Interleaved so neither end can block on a full buffer.
    while (`$sent -lt 8192) {
      `$chunk = [Math]::Min(2048, 8192 - `$sent)
      `$s.Write(`$payload, `$sent, `$chunk)
      `$s.Flush()
      `$sent += `$chunk
      `$need = `$sent - `$got
      while (`$need -gt 0) {
        `$n = `$s.Read(`$back, `$got, `$need)
        if (`$n -le 0) { break }
        `$got += `$n; `$need -= `$n
      }
    }
    `$d.sent = `$sent; `$d.received = `$got
    if (`$got -eq 8192 -and (Test-Payload `$back 8192)) { `$bits = `$bits -bor 8 }
    `$c.Close()
  } catch { `$d.connectorError = (Get-SockErr `$_) }
  `$d.bits = `$bits
  try { `$d | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path `$work 'connector.json') } catch {}
  exit `$bits
}

# ============================================================================
# ROLE: probe - the single-process battery.
# ============================================================================
`$bits = 0
`$detail = @{}

# 64 = the child ran at all.
try {
  Set-Content -LiteralPath (Join-Path `$work 'started.txt') -Value 'started'
  `$bits = `$bits -bor 64
} catch { exit 0 }

`$detail.cwd = (Get-Location).Path
`$detail.temp = `$env:TEMP
try { `$detail.identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name } catch {}

# --- 1 = bind + listen on loopback inside the container.
# bind() and listen() are NOT where WFP filters an AppContainer; ALE filters at
# connect and accept. A successful bind alone is close to meaningless, which is
# why bit 2 insists on a completed round trip with real bytes.
`$listener = `$null
try {
  `$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  `$listener.Start()
  `$detail.listenPort = ([Net.IPEndPoint]`$listener.Server.LocalEndPoint).Port
  `$bits = `$bits -bor 1
} catch { `$detail.listenError = (Get-SockErr `$_) }

# --- 2 = a real loopback ROUND TRIP inside this one process.
if (`$listener) {
  `$cli = `$null; `$srv = `$null
  try {
    `$acc = `$listener.BeginAcceptTcpClient(`$null, `$null)
    `$cli = [Net.Sockets.TcpClient]::new()
    `$iar = `$cli.BeginConnect([Net.IPAddress]::Loopback, `$detail.listenPort, `$null, `$null)
    if (-not `$iar.AsyncWaitHandle.WaitOne(3000)) { throw 'self-connect timed out' }
    `$cli.EndConnect(`$iar)
    if (-not `$acc.AsyncWaitHandle.WaitOne(3000)) { throw 'accept timed out' }
    `$srv = `$listener.EndAcceptTcpClient(`$acc)
    `$payload = [byte[]] (1, 2, 3, 4)
    `$cli.GetStream().Write(`$payload, 0, 4)
    `$cli.GetStream().Flush()
    `$buf = New-Object byte[] 4
    `$srv.ReceiveTimeout = 3000
    `$n = `$srv.GetStream().Read(`$buf, 0, 4)
    if (`$n -eq 4 -and `$buf[0] -eq 1 -and `$buf[3] -eq 4) { `$bits = `$bits -bor 2 }
    `$detail.loopbackBytes = `$n
  } catch { `$detail.roundTripError = (Get-SockErr `$_) }
  finally {
    if (`$cli) { `$cli.Close() }
    if (`$srv) { `$srv.Close() }
  }
}

# --- 4 = reach the OUTSIDE world. Expected NO.
# EndConnect is mandatory: async socket faults surface there, not at
# BeginConnect. Without it the error code - the only thing separating WSAEACCES
# from 'this machine has no route' - is discarded exactly when the test fails.
try {
  `$c = [Net.Sockets.TcpClient]::new()
  try {
    `$iar = `$c.BeginConnect('1.1.1.1', 443, `$null, `$null)
    if (`$iar.AsyncWaitHandle.WaitOne(5000)) { `$c.EndConnect(`$iar); `$bits = `$bits -bor 4 }
    else { `$detail.outboundError = @{ code = 0; name = 'Timeout'; message = 'no response in 5s' } }
  } finally { `$c.Close() }
} catch { `$detail.outboundError = (Get-SockErr `$_) }

# --- 8 = reach a listener on the HOST's loopback.
try {
  `$c = [Net.Sockets.TcpClient]::new()
  try {
    `$iar = `$c.BeginConnect([Net.IPAddress]::Loopback, `$hostPort, `$null, `$null)
    if (`$iar.AsyncWaitHandle.WaitOne(3000)) { `$c.EndConnect(`$iar); `$bits = `$bits -bor 8 }
    else { `$detail.hostLoopbackError = @{ code = 0; name = 'Timeout'; message = 'no response in 3s' } }
  } finally { `$c.Close() }
} catch { `$detail.hostLoopbackError = (Get-SockErr `$_) }

# --- 16 / 512 / 1024 = the broker pipe: open, echo, sustain.
#   16   = handle opened
#   512  = 4-byte echo returned identical (duplex works at all)
#   1024 = 64 KiB each way, interleaved, content verified (it is a transport)
try {
  `$p = New-Object System.IO.Pipes.NamedPipeClientStream('.', `$pipeAcl, [System.IO.Pipes.PipeDirection]::InOut)
  try {
    `$p.Connect(4000)
    `$bits = `$bits -bor 16

    `$small = [byte[]] (7, 7, 7, 7)
    `$p.Write(`$small, 0, 4); `$p.Flush()
    `$echo = New-Object byte[] 4
    `$got = 0
    while (`$got -lt 4) {
      `$n = Read-Timed `$p `$echo `$got (4 - `$got) 8000
      if (`$n -le 0) { break }
      `$got += `$n
    }
    if (`$got -eq 4 -and `$echo[0] -eq 7 -and `$echo[3] -eq 7) { `$bits = `$bits -bor 512 }
    `$detail.pipeEchoBytes = `$got

    # Sustained. Interleaved writes and reads: 64 KiB pushed blindly would
    # deadlock against the server's own 64 KiB buffer, and a deadlock would
    # look identical to 'the pipe cannot carry traffic'.
    `$total = 65536
    `$payload = New-Payload `$total
    `$back = New-Object byte[] `$total
    `$sent = 0; `$recv = 0
    while (`$sent -lt `$total) {
      `$chunk = [Math]::Min(8192, `$total - `$sent)
      `$p.Write(`$payload, `$sent, `$chunk); `$p.Flush()
      `$sent += `$chunk
      `$need = `$sent - `$recv
      while (`$need -gt 0) {
        `$n = Read-Timed `$p `$back `$recv `$need 8000
        if (`$n -le 0) { break }
        `$recv += `$n; `$need -= `$n
      }
    }
    `$detail.pipeSustained = @{ sent = `$sent; received = `$recv }
    if (`$recv -eq `$total -and (Test-Payload `$back `$total)) { `$bits = `$bits -bor 1024 }
  } finally { `$p.Dispose() }
} catch {
  `$detail.pipeAclError = @{ message = `$_.Exception.Message; hresult = `$_.Exception.HResult }
}

# --- 32 = the DEFAULT-DACL pipe. The control. Expected NO.
try {
  `$p = New-Object System.IO.Pipes.NamedPipeClientStream('.', `$pipeDefault, [System.IO.Pipes.PipeDirection]::InOut)
  try {
    `$p.Connect(2000)
    `$p.Write([byte[]](9, 9, 9, 9), 0, 4)
    `$p.Flush()
    `$bits = `$bits -bor 32
  } finally { `$p.Dispose() }
} catch {
  `$detail.pipeDefaultError = @{ message = `$_.Exception.Message; hresult = `$_.Exception.HResult }
}

# --- 128 = a name that DOES resolve. The DNS positive control.
# A resolver refusing an AppContainer token reports WSAHOST_NOT_FOUND, the same
# code as a genuine NXDOMAIN, so the uncacheable probe below is uninterpretable
# unless this passes.
try {
  [Net.Dns]::GetHostAddresses('pypi.org') | Out-Null
  `$bits = `$bits -bor 128
} catch { `$detail.dnsCachedError = (Get-SockErr `$_) }

# --- 256 = the uncacheable name returned HostNotFound rather than a transport
# failure. AMBIGUOUS ALONE. Interpretation deferred to the host.
try {
  [Net.Dns]::GetHostAddresses(`$dnsProbe) | Out-Null
  `$bits = `$bits -bor 256
  `$detail.dnsProbeResult = 'resolved (wildcard answered)'
} catch {
  `$err = Get-SockErr `$_
  `$detail.dnsProbeError = `$err
  if (`$err.name -eq 'HostNotFound') { `$bits = `$bits -bor 256; `$detail.dnsProbeResult = 'HostNotFound (ambiguous alone)' }
  else { `$detail.dnsProbeResult = 'transport failure' }
}

# ---------------------------------------------------------------- filesystem
# pip does not only need sockets. It unpacks wheels, writes caches, and creates
# nested trees. None of that was ever measured, and the TEMP override below
# makes the filesystem picture less predictable than it looks.

# --- 131072 = read System32. POSITIVE CONTROL: the package SID is a member of
# ALL APPLICATION PACKAGES, which is granted read there by default. If this
# fails, every other filesystem result is measuring something else.
try {
  [IO.File]::ReadAllBytes((Join-Path `$env:SystemRoot 'System32\drivers\etc\hosts')) | Out-Null
  `$bits = `$bits -bor 131072
} catch { `$detail.system32ReadError = `$_.Exception.Message }

# --- 2048 = write to the explicitly ACL'd directory.
try {
  `$f = Join-Path `$work 'fs-acl-write.txt'
  Set-Content -LiteralPath `$f -Value 'ok'
  if ((Get-Content -LiteralPath `$f -Raw).Trim() -eq 'ok') { `$bits = `$bits -bor 2048 }
} catch { `$detail.aclWriteError = `$_.Exception.Message }

# --- 4096 = write to the package's OWN temp, with NO explicit grant from us.
# If this works, the icacls step in the launcher is unnecessary and the broker
# does not have to provision anything.
try {
  `$acTemp = `$env:TEMP
  `$detail.acTemp = `$acTemp
  `$f = Join-Path `$acTemp 'fs-actemp-write.txt'
  Set-Content -LiteralPath `$f -Value 'ok'
  if ((Get-Content -LiteralPath `$f -Raw).Trim() -eq 'ok') { `$bits = `$bits -bor 4096 }
} catch { `$detail.acTempWriteError = `$_.Exception.Message }

# --- 32768 = a site-packages shaped workload: nested tree, many files, one
# 1 MiB file, then read back. Wheel extraction in miniature.
try {
  `$root = Join-Path `$env:TEMP 'site-packages-sim'
  `$deep = Join-Path `$root 'pkg\sub\_internal\data'
  New-Item -ItemType Directory -Path `$deep -Force | Out-Null
  for (`$i = 0; `$i -lt 25; `$i++) {
    Set-Content -LiteralPath (Join-Path `$deep ("mod`$i.py")) -Value ("# module `$i")
  }
  `$big = New-Payload 1048576
  [IO.File]::WriteAllBytes((Join-Path `$deep 'blob.bin'), `$big)
  `$readBack = [IO.File]::ReadAllBytes((Join-Path `$deep 'blob.bin'))
  `$count = (Get-ChildItem -LiteralPath `$deep -File).Count
  `$detail.sitePackagesSim = @{ files = `$count; blobBytes = `$readBack.Length }
  if (`$count -ge 26 -and `$readBack.Length -eq 1048576 -and (Test-Payload `$readBack 1048576)) {
    `$bits = `$bits -bor 32768
  }
} catch { `$detail.sitePackagesError = `$_.Exception.Message }

# --- 8192 = read a file in the user profile. Expected NO.
try {
  [IO.File]::ReadAllText(`$profileRead) | Out-Null
  `$bits = `$bits -bor 8192
} catch { `$detail.profileReadError = `$_.Exception.Message }

# --- 16384 = write a file into the user profile. Expected NO. If this
# succeeds, the sandbox is not containing the filesystem at all.
try {
  Set-Content -LiteralPath `$profileWrite -Value 'escaped'
  `$bits = `$bits -bor 16384
} catch { `$detail.profileWriteError = `$_.Exception.Message }

# --------------------------------------------------------------- environment
# The launcher set TEMP and TMP explicitly. Windows gives an AppContainer a
# private per-package AC\Temp at process init and may override them. Anything
# in the design that steers the sandboxed process by environment variable -
# HTTP_PROXY, PIP_INDEX_URL, SSL_CERT_FILE - depends on which of these survive.
# --- 65536 = the launcher's TEMP survived.
try {
  `$detail.envSurvival = @{
    TEMP_expected = `$work
    TEMP_actual   = `$env:TEMP
    TMP_actual    = `$env:TMP
    OS_PROBE_MARK = `$env:OS_PROBE_MARK
    HTTP_PROXY    = `$env:HTTP_PROXY
    USERPROFILE   = `$env:USERPROFILE
  }
  if (`$env:TEMP -eq `$work) { `$bits = `$bits -bor 65536 }
} catch { }

if (`$listener) { try { `$listener.Stop() } catch {} }
`$detail.bits = `$bits
try { `$detail | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path `$work 'report.json') } catch {}
exit `$bits
"@ | Set-Content -LiteralPath $childPath -Encoding UTF8

# -- 2. Launch ---------------------------------------------------------------
Say "2. Launch a child into the AppContainer with NO capabilities" "White"
$ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
function ChildCmd([string] $role) {
  '"{0}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{1}" -Role {2}' -f $ps, $childPath, $role
}

# The launcher's full environment with the writable paths redirected, plus two
# canaries whose survival is itself measured. A hand-rolled minimal block is the
# more principled option and also the more fragile one: miss one variable the
# CLR wants and the failure is indistinguishable from a sandbox refusal.
$childEnv = @()
foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
  $k = [string]$entry.Key
  if ([string]::IsNullOrEmpty($k)) { continue }
  if ($k.StartsWith('=')) { continue }              # hidden per-drive cwd entries
  if ($k -match '^(TEMP|TMP)$') { continue }        # replaced below
  $childEnv += ("{0}={1}" -f $k, [string]$entry.Value)
}
$childEnv += "TEMP=$work"
$childEnv += "TMP=$work"
$childEnv += "OS_PROBE_MARK=survived"
$childEnv += "HTTP_PROXY=http://127.0.0.1:9/"

$res = $null
try {
  $res = [OpenScience.AppContainer]::LaunchWithFallback($sid, (ChildCmd 'probe'), $work, $childEnv, 60000)
} catch {
  Say ("  FAILED before CreateProcess: {0}" -f $_.Exception.Message) "Red"
  Say "  This is an interop fault in the probe, not a finding about the design." "Yellow"
}

$code = if ($res) { $res.ExitCode } else { $null }
$launchErr = if ($res) { $res.Win32Error } else { 0 }

if ($res) {
  Result "CreateProcess into the AppContainer succeeded" $res.Started "yes" $res.Stage
  if ($res.PreviousWin32Error -ne 0) {
    Say ("  NOTE: an earlier rung failed with Win32 {0}. That is a probe bug," -f $res.PreviousWin32Error) "Yellow"
    Say "  not a sandbox property. 203 ERROR_ENVVAR_NOT_FOUND means the" "Yellow"
    Say "  environment block was malformed; 267 means the cwd was unusable." "Yellow"
  }
  if (-not $res.Started) {
    Say ("  all rungs failed; last Win32 error {0}" -f $res.Win32Error) "Red"
    Say "  Only if EVERY rung fails with an access error is this a finding:" "Yellow"
    Say "  a stock powershell.exe cannot start in an empty AppContainer, and" "Yellow"
    Say "  the design needs a purpose-built child binary." "Yellow"
  }
}

$ran = Test-Path -LiteralPath $marker
Result "child process actually started" $ran "yes"
if ($res -and $res.TimedOut) { Say "  (child timed out)" "Yellow" }
Say ""

$hostListener.Stop()

# -- 2b. Two processes in the same container ---------------------------------
# The single-process loopback test proves the socket stack works. It does NOT
# prove a shim in one process can serve pip in another - a claim about
# same-package traffic between two live tokens, which is the arrangement the
# design actually ships.
Say "2b. Two processes in the SAME AppContainer, talking over loopback" "White"
$twoProc = @{}
$listenerRes = $null
$connectorRes = $null
if ($ran) {
  try {
    Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
    $hListener = [OpenScience.AppContainer]::Start($sid, (ChildCmd 'listener'), $work, $childEnv)
    if (-not $hListener.Started) {
      Say ("  listener failed to start: Win32 {0}" -f $hListener.Win32Error) "Red"
    } else {
      Start-Sleep -Milliseconds 400   # let it reach the bind before the peer polls
      $hConnector = [OpenScience.AppContainer]::Start($sid, (ChildCmd 'connector'), $work, $childEnv)
      if (-not $hConnector.Started) {
        Say ("  connector failed to start: Win32 {0}" -f $hConnector.Win32Error) "Red"
      } else {
        $connectorRes = [OpenScience.AppContainer]::Wait($hConnector, 45000)
      }
      $listenerRes = [OpenScience.AppContainer]::Wait($hListener, 45000)
    }
  } catch {
    Say ("  two-process test failed to run: {0}" -f $_.Exception.Message) "Red"
  }

  $lDetail = $null; $cDetail = $null
  if (Test-Path -LiteralPath $listenerReport) {
    try { $lDetail = Get-Content -LiteralPath $listenerReport -Raw | ConvertFrom-Json } catch {}
  }
  if (Test-Path -LiteralPath $connectorReport) {
    try { $cDetail = Get-Content -LiteralPath $connectorReport -Raw | ConvertFrom-Json } catch {}
  }
  $lBits = if ($lDetail) { [int]$lDetail.bits } elseif ($listenerRes -and $listenerRes.ExitCode -ge 0) { $listenerRes.ExitCode } else { 0 }
  $cBits = if ($cDetail) { [int]$cDetail.bits } elseif ($connectorRes -and $connectorRes.ExitCode -ge 0) { $connectorRes.ExitCode } else { 0 }
  $twoProc = @{ listenerBits = $lBits; connectorBits = $cBits; listener = $lDetail; connector = $cDetail }

  Result "listener process bound a loopback port"  (($lBits -band 2) -ne 0) "either"
  Result "listener ACCEPTED from the other process" (($lBits -band 4) -ne 0) "either" (
    $(if ($lDetail -and $lDetail.acceptedFrom) { "peer " + $lDetail.acceptedFrom } else { "" }))
  Result "connector CONNECTED to the other process" (($cBits -band 4) -ne 0) "either" (
    $(if ($cDetail -and $cDetail.connectorError) { $cDetail.connectorError.name } else { "" }))
  Result "8 KiB echoed between them, content verified" (($cBits -band 8) -ne 0) "either" (
    $(if ($cDetail) { "sent {0} / received {1}" -f $cDetail.sent, $cDetail.received } else { "" }))
} else {
  Say "  skipped: the single-process child never ran" "DarkGray"
}
$crossProcess = ((($twoProc.connectorBits) -band 8) -ne 0)
Say ""

# Host-side corroboration of the pipe, read after all children have exited.
$echoAclBytes = $echoAcl.BytesEchoed
$echoAclConnected = $echoAcl.Connected
$echoDefaultConnected = $echoDefault.Connected
$echoAclError = $echoAcl.Error
$echoAcl.Stop()
$echoDefault.Stop()

# -- 3. Results --------------------------------------------------------------
$detail = $null
if (Test-Path -LiteralPath $report) {
  try { $detail = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json } catch {}
}
$bits = if ($detail -and $null -ne $detail.bits) { [int]$detail.bits } elseif ($code -ge 0) { [int]$code } else { -1 }

function ErrNote($obj) {
  if ($null -eq $obj) { return "" }
  if ($obj.PSObject.Properties['name']) { return ("{0} ({1})" -f $obj.name, $obj.code) }
  if ($obj.PSObject.Properties['message']) { return $obj.message }
  return ""
}

if ($ran -and $bits -ge 0) {
  Say "3. Network" "White"
  Result "bind + listen on loopback INSIDE the container" (($bits -band 1) -ne 0) "either"
  Result "loopback round trip within ONE process"         (($bits -band 2) -ne 0) "either" (
    ErrNote $detail.roundTripError)
  Result "loopback round trip ACROSS two processes"       $crossProcess "either" "see 2b"
  Result "connect outbound to 1.1.1.1:443"                (($bits -band 4) -ne 0) "no" (
    ErrNote $detail.outboundError)
  Result "connect to a listener on the HOST loopback"     (($bits -band 8) -ne 0) "no" (
    ErrNote $detail.hostLoopbackError)
  Say ""

  Say "   Broker pipe" "White"
  Result "open host pipe (package SID GRANTED)"           (($bits -band 16) -ne 0) "either" (
    ErrNote $detail.pipeAclError)
  Result "4-byte echo returned identical (duplex works)"  (($bits -band 512) -ne 0) "either"
  Result "64 KiB each way, interleaved, content verified" (($bits -band 1024) -ne 0) "either" (
    $(if ($detail.pipeSustained) { "sent {0} / received {1}" -f $detail.pipeSustained.sent, $detail.pipeSustained.received } else { "" }))
  Result "open host pipe (default DACL) [CONTROL]"        (($bits -band 32) -ne 0) "no" (
    ErrNote $detail.pipeDefaultError)
  Result "host echo server saw the GRANTED connection"    $echoAclConnected "either" (
    "{0} bytes echoed host-side" -f $echoAclBytes)
  Result "host echo server saw the DEFAULT connection"    $echoDefaultConnected "no"
  if ((($bits -band 16) -ne 0) -ne $echoAclConnected) {
    Say "  DISAGREEMENT between child and host on the granted pipe. Do not" "Red"
    Say "  trust either number until this is explained." "Red"
  }
  Say ""

  Say "   Filesystem" "White"
  Result "read System32 (positive CONTROL)"               (($bits -band 131072) -ne 0) "yes" (
    $(if ($detail.system32ReadError) { $detail.system32ReadError } else { "" }))
  Result "write to the explicitly ACL'd temp dir"         (($bits -band 2048) -ne 0) "yes" (
    $(if ($detail.aclWriteError) { $detail.aclWriteError } else { "" }))
  Result "write to the package's OWN temp, no grant"      (($bits -band 4096) -ne 0) "either" (
    $(if ($detail.acTemp) { $detail.acTemp } else { "" }))
  Result "site-packages sim: tree + 1 MiB, verified"      (($bits -band 32768) -ne 0) "either" (
    $(if ($detail.sitePackagesSim) { "{0} files, {1} bytes" -f $detail.sitePackagesSim.files, $detail.sitePackagesSim.blobBytes }
      else { $detail.sitePackagesError }))
  Result "READ a file in the user profile"                (($bits -band 8192) -ne 0) "no"
  Result "WRITE a file into the user profile"             (($bits -band 16384) -ne 0) "no"
  if ((($bits -band 131072) -eq 0)) {
    Say "  CONTROL FAILED: System32 is unreadable. The filesystem results above" "Red"
    Say "  are measuring something other than what they claim." "Red"
  }
  if ((($bits -band 4096) -ne 0) -and (($bits -band 2048) -ne 0)) {
    Say "  The package's own temp is writable WITHOUT the launcher granting" "Cyan"
    Say "  anything. The icacls step may be unnecessary; the broker would not" "Cyan"
    Say "  have to provision scratch space." "Cyan"
  }
  Say ""

  Say "   Environment and DNS" "White"
  Result "the launcher's TEMP survived into the child"    (($bits -band 65536) -ne 0) "either" (
    $(if ($detail.envSurvival) { "actual: " + $detail.envSurvival.TEMP_actual } else { "" }))
  if ($detail.envSurvival) {
    Say ("     OS_PROBE_MARK  : {0}" -f $(if ($detail.envSurvival.OS_PROBE_MARK) { $detail.envSurvival.OS_PROBE_MARK } else { "<lost>" })) "DarkGray"
    Say ("     HTTP_PROXY     : {0}" -f $(if ($detail.envSurvival.HTTP_PROXY) { $detail.envSurvival.HTTP_PROXY } else { "<lost>" })) "DarkGray"
  }
  if ((($bits -band 65536) -eq 0) -and $detail.envSurvival -and $detail.envSurvival.OS_PROBE_MARK) {
    Say "  TEMP was overridden by Windows but ordinary variables survived. Any" "Cyan"
    Say "  design that steers the sandbox by environment must avoid the path" "Cyan"
    Say "  variables Windows reserves per-package." "Cyan"
  }

  $dnsControl = (($bits -band 128) -ne 0)
  $dnsProbeHostNotFound = (($bits -band 256) -ne 0)
  $dnsWorks = $dnsControl -and $dnsProbeHostNotFound
  Result "positive control: a name that DOES resolve"     $dnsControl "either" (
    $(if (-not $dnsControl) { "control FAILED - probe result carries no information" } else { "" }))
  Result "DNS resolution works inside the container"      $dnsWorks "no" (
    $(if ($dnsControl) { $detail.dnsProbeResult }
      else { "HostNotFound on the probe is refusal, not NXDOMAIN" }))
  if (-not $dnsControl -and -not $hostDnsOk) {
    Say "  NOTE: the HOST could not resolve pypi.org either. This says nothing" "Yellow"
    Say "  about the container - re-run when host DNS is working." "Yellow"
  }
  Say ""

  # -- Verdict ---------------------------------------------------------------
  $controlsHeld = ((($bits -band 32) -eq 0) -and (($bits -band 131072) -ne 0))
  $canServe = $crossProcess
  $canEgress = ((($bits -band 16) -ne 0) -and (($bits -band 512) -ne 0) -and (($bits -band 1024) -ne 0))
  $fsOk = ((($bits -band 32768) -ne 0) -and ((($bits -band 2048) -ne 0) -or (($bits -band 4096) -ne 0)))
  $contained = ((($bits -band 4) -eq 0) -and (($bits -band 16384) -eq 0))

  Say "VERDICT" "White"
  if (-not $controlsHeld) {
    Say "  CONTROLS FAILED. Either the default-DACL pipe opened (so the" "Red"
    Say "  package-SID grant is not what produced the pipe result) or System32" "Red"
    Say "  was unreadable (so the filesystem results are measuring something" "Red"
    Say "  else). Everything below is provisional." "Red"
    Say ""
  }
  if ($canServe -and $canEgress -and $fsOk) {
    Say "  The full chain holds, measured end to end:" "Green"
    Say "    pip -> loopback -> shim (separate process, same package)" "Green"
    Say "    shim -> named pipe -> broker, 64 KiB verified both directions" "Green"
    Say "    wheel-shaped filesystem writes succeed inside the container" "Green"
    Say "  The Linux/macOS shim model transfers. Windows can be" "Green"
    Say "  socket-transparent: unmodified pip works against a loopback proxy." "Green"
  } elseif ($canEgress -and -not $canServe) {
    Say "  The broker pipe works but cross-process loopback does NOT." "Yellow"
    Say "  A shim cannot serve pip from a separate process, so Windows must be" "Yellow"
    Say "  capability-mediated: code has to ASK the broker rather than connect." "Yellow"
    Say "  Package installation moves into the broker's trust domain, and a" "Yellow"
    Say "  notebook cell cannot fetch a URL directly." "Yellow"
  } elseif ($canServe -and -not $canEgress) {
    Say "  Cross-process loopback works but the pipe is not a usable transport." "Red"
    Say "  A shim would accept pip's connection and then have nowhere to send" "Red"
    Say "  it - it holds the same zero capabilities pip does. Loopback alone is" "Red"
    Say "  necessary, not sufficient. Try ALPC, a COM broker, or passing an" "Red"
    Say "  already-connected socket handle in at process creation." "Red"
  } elseif (-not $fsOk) {
    Say "  The transport chain works but the filesystem does not support a" "Yellow"
    Say "  wheel-shaped workload. Sockets were never the binding constraint." "Yellow"
  } else {
    Say "  Neither half of the chain holds. Re-examine the transport choice" "Red"
    Say "  before anything else in the spec." "Red"
  }

  if (-not $contained) {
    Say ""
    Say "  CONTAINMENT BREACH: the container reached the network with no" "Red"
    Say "  capabilities granted, or wrote into the user profile. Check section" "Red"
    Say "  0 FIRST - with MpsSvc stopped or third-party filtering in place the" "Red"
    Say "  network half is a fact about the machine, not the design. If" "Red"
    Say "  enforcement was healthy, this is the most important line here." "Red"
  }
  if ((($bits -band 8) -ne 0) -and $hostContext.loopbackExemptCount -gt 0) {
    Say ""
    Say ("  NOTE: host loopback succeeded and this machine carries {0} loopback" -f `
      $hostContext.loopbackExemptCount) "Yellow"
    Say "  exemption(s). That YES may be inherited configuration." "Yellow"
  }

  Say ""
  Say "Raw detail (paste this back):" "White"
  $bundle = @{
    host      = $hostContext
    sid       = $sid
    exitCode  = $code
    bits      = $bits
    launch    = @{
      stage        = $(if ($res) { $res.Stage } else { $null })
      started      = $(if ($res) { $res.Started } else { $false })
      win32        = $launchErr
      earlierWin32 = $(if ($res) { $res.PreviousWin32Error } else { 0 })
    }
    pipeHost  = @{
      grantedConnected = $echoAclConnected
      grantedBytes     = $echoAclBytes
      grantedError     = $echoAclError
      defaultConnected = $echoDefaultConnected
    }
    twoProcess = $twoProc
    child      = $detail
    elevated   = $elevated
    os         = [Environment]::OSVersion.Version.ToString()
  }
  $json = $bundle | ConvertTo-Json -Depth 7
  Write-Host $json
  # Also written to a file beside this script, and deliberately NOT into the
  # temp directory that cleanup removes. The first real run of this probe was
  # reported by pasting the console output, which the terminal had truncated
  # from the top - the environment-survival block was in the part that scrolled
  # away, and that was the one question the run existed to answer.
  $out = Join-Path (Split-Path -Parent $PSCommandPath) "probe-report.json"
  try {
    Set-Content -LiteralPath $out -Value $json -Encoding UTF8
    Say ""
    Say ("Full report written to: {0}" -f $out) "Green"
    Say "Send that file rather than the console output - it cannot be truncated." "Green"
  } catch {
    Say ("Could not write the report file: {0}" -f $_.Exception.Message) "Yellow"
  }
} else {
  Say "3. No usable result - the child did not report." "Red"
  Say ("  launch stage : {0}" -f $(if ($res) { $res.Stage } else { "<none reached>" })) "Red"
  Say ("  started      : {0}" -f $(if ($res) { $res.Started } else { "n/a" })) "Red"
  Say ("  exit code    : {0}" -f $(if ($null -ne $code) { $code } else { "n/a" })) "Red"
  Say ("  CreateProcess: Win32 {0}" -f $launchErr) "Red"
  Say ("  marker file  : {0}" -f $(if ($ran) { "present" } else { "absent" })) "Red"
  Say "  If CreateProcess succeeded and the marker is absent, the child started" "Yellow"
  Say "  and died before it could write. Re-run with -Keep and inspect the temp" "Yellow"
  Say "  directory; the usual cause is a path the token cannot read." "Yellow"
  $out = Join-Path (Split-Path -Parent $PSCommandPath) "probe-report.json"
  try {
    @{
      host    = $hostContext
      sid     = $sid
      failed  = $true
      launch  = @{
        stage        = $(if ($res) { $res.Stage } else { $null })
        started      = $(if ($res) { $res.Started } else { $false })
        win32        = $launchErr
        earlierWin32 = $(if ($res) { $res.PreviousWin32Error } else { 0 })
      }
      marker  = $ran
      exit    = $code
      os      = [Environment]::OSVersion.Version.ToString()
      elevated = $elevated
    } | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $out -Encoding UTF8
    Say ("  Report written to: {0}" -f $out) "Yellow"
  } catch { }
}

# -- Cleanup -----------------------------------------------------------------
Say ""
# The user-profile write target must not survive a run, whether or not the
# write succeeded.
if (Test-Path -LiteralPath $profileWrite) {
  Remove-Item -LiteralPath $profileWrite -Force -ErrorAction SilentlyContinue
  Say "  removed the user-profile escape artefact (it should not have existed)" "Red"
}
if (-not $Keep) {
  [OpenScience.AppContainer]::Delete($Name)
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  Say "Cleaned up the profile and temp directory." "Gray"
} else {
  Say ("Kept profile '{0}' and {1}" -f $Name, $work) "Gray"
}
Say ""