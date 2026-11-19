import {execFileSync} from 'node:child_process';

export function windowsPrivateDirectory(directory,create=false) {
  if(process.platform!=='win32')return;
  const script=`
    $ErrorActionPreference='Stop'
    $path=$env:PROTON_PRIVATE_DIRECTORY
    $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
    if($env:PROTON_CREATE_PRIVATE -eq '1') {
      $null=New-Item -ItemType Directory -Path $path -Force
      $acl=Get-Acl -LiteralPath $path
      if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value){throw 'Unexpected private directory owner'}
      $acl.SetAccessRuleProtection($true,$false)
      foreach($rule in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){$null=$acl.RemoveAccessRuleAll($rule)}
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($owner,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
      ([IO.DirectoryInfo]::new($path)).SetAccessControl($acl)
    }
    $root=Get-Item -LiteralPath $path
    if(!$root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe restore directory'}
    $rootAcl=Get-Acl -LiteralPath $path
    if(!$rootAcl.AreAccessRulesProtected -or $rootAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value){throw 'Private restore root required'}
    $items=@($root)+@(Get-ChildItem -LiteralPath $path -Force -Recurse)
    foreach($item in $items) {
      if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Restore links require POSIX validation'}
      $acl=Get-Acl -LiteralPath $item.FullName
      if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value){throw 'Unexpected restore owner'}
      foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $owner.Value){throw 'Unexpected restore access'}
      }
    }
  `;
  const env={...process.env,PROTON_PRIVATE_DIRECTORY:directory,PROTON_CREATE_PRIVATE:create?'1':'0'};
  // Windows PowerShell must resolve its own modules when launched from PowerShell 7.
  for(const name of Object.keys(env))if(name.toLowerCase()==='psmodulepath')delete env[name];
  try {
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{
      env,stdio:['ignore','pipe','pipe'],timeout:180000,
    });
  } catch {throw new Error('Owner-only Windows restore directory permissions could not be verified.');}
}

if(process.argv[2]==='--create')windowsPrivateDirectory(process.argv[3],true);
