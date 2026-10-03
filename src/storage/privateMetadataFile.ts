import { execFile } from "node:child_process";
import { lstat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

// Windows chmod does not express owner-only access. Set and verify the same
// protected current-user + LocalSystem DACL required by ts-connect, before
// writing any bytes. The path is data on stdin, never interpolated into code.
const WINDOWS_PRIVATE_FILE_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
  $file = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $item = Get-Item -LiteralPath $file -Force
  if ($item.PSIsContainer -or $item.Length -ne 0 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 1 }
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $old = Get-Acl -LiteralPath $file
  if ($old.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 1 }
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, 'FullControl', 'Allow'))
  Set-Acl -LiteralPath $file -AclObject $acl
  $checked = Get-Acl -LiteralPath $file
  $rules = @($checked.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (!$checked.AreAccessRulesProtected -or $rules.Count -ne 2) { exit 1 }
  $found = @{}
  foreach ($rule in $rules) {
    $id = $rule.IdentityReference.Value
    if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { exit 1 }
    if ($id -ne $sid.Value -and $id -ne $system.Value) { exit 1 }
    $found[$id] = $true
  }
  if (!$found[$sid.Value] -or !$found[$system.Value]) { exit 1 }
  [Console]::Out.Write('protected')
} catch { exit 1 }
`;

/** Only for a newly created, still-empty file owned by the current writer. */
export async function protectNewPrivateMetadataFile(filePath: string): Promise<void> {
  const failure = () => new Error("Private metadata file protection failed.");
  try {
    if (!path.isAbsolute(filePath)) throw failure();
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== 0) throw failure();
    if (process.platform !== "win32") return;
    const windowsRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!windowsRoot || !/^[A-Za-z]:\\/u.test(windowsRoot) || windowsRoot.includes("\0")) throw failure();
    const executable = path.win32.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await new Promise<void>((resolve, reject) => {
      const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(WINDOWS_PRIVATE_FILE_SCRIPT, "utf16le").toString("base64")], {
        encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 4096,
        env: { SystemRoot: windowsRoot, WINDIR: windowsRoot }
      }, (error, stdout) => {
        if (error || stdout !== "protected") reject(failure());
        else resolve();
      });
      child.stdin?.on("error", () => reject(failure()));
      child.stdin?.end(JSON.stringify(filePath));
    });
  } catch {
    throw failure();
  }
}

/** Remove only our still-empty creation if protection failed before writing. */
export async function discardOwnedEmptyMetadataFile(filePath: string, handle: FileHandle): Promise<void> {
  try {
    const [owned, current] = await Promise.all([handle.stat(), lstat(filePath)]);
    if (owned.ino !== 0 && current.isFile() && !current.isSymbolicLink()
      && owned.ino === current.ino && owned.dev === current.dev
      && owned.size === 0 && current.size === 0) await unlink(filePath);
  } catch {
    // Keep the original protection error; never broaden cleanup if identity is uncertain.
  }
}
