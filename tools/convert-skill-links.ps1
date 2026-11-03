param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$source = Join-Path $root 'data\personal-workflow.md'
$sourceItem = Get-Item -LiteralPath $source
if ($sourceItem.PSIsContainer -or $sourceItem.LinkType -eq 'SymbolicLink') {
    throw '唯一源文件必须是实体文件，不能是目录或软链接。'
}
# Windows PowerShell 5.1 按调用者当前目录解析 New-Item 的相对 Target；使用已解析的绝对源路径。
function Test-SourceTarget($item) {
    # 不依赖 .NET 6 的 ResolveLinkTarget，管理员 Windows PowerShell 也可运行。
    $target = [string]$item.Target
    if (-not [IO.Path]::IsPathRooted($target)) {
        $target = Join-Path $item.DirectoryName $target
    }
    return [string]::Equals([IO.Path]::GetFullPath($target), $sourceItem.FullName,
        [StringComparison]::OrdinalIgnoreCase)
}
$aliases = @('.codex', '.claude', '.workbuddy-ai') | ForEach-Object {
    Join-Path $root "$_\skills\fill-job-application\SKILL.md"
}

# 先核对三个入口；防止把内容已分叉的独立文件误当作旧入口删除。
foreach ($alias in $aliases) {
    if (-not (Test-Path -LiteralPath $alias) -and -not (Get-Item -LiteralPath $alias -ErrorAction SilentlyContinue)) { continue }
    $item = Get-Item -LiteralPath $alias
    if ($item.LinkType -eq 'SymbolicLink') {
        if (-not (Test-SourceTarget $item)) {
            throw "软链接指向其他文件，停止：$alias"
        }
    } elseif ($item.LinkType -ne 'HardLink' -or
        (Get-FileHash -LiteralPath $alias).Hash -ne (Get-FileHash -LiteralPath $source).Hash) {
        throw "入口不是与源内容相同的硬链接，停止：$alias"
    }
}
if ($CheckOnly) {
    $aliases | ForEach-Object {
        if (Test-Path -LiteralPath $_) { Get-Item -LiteralPath $_ | Select-Object FullName, LinkType, Target }
        else { [pscustomobject]@{FullName=$_;LinkType='Missing (will create)';Target=$source} }
    }
    return
}

foreach ($alias in $aliases) {
    $existing = Get-Item -LiteralPath $alias -ErrorAction SilentlyContinue
    if ($existing -and $existing.LinkType -eq 'SymbolicLink') { continue }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $alias)) | Out-Null
    $pending = Join-Path (Split-Path -Parent $alias) ('.skill-link-' + [guid]::NewGuid().ToString('N'))
    # 在解除旧硬链接之前先证明创建软链接的权限；失败时原入口保持可用。
    New-Item -ItemType SymbolicLink -Path $pending -Target $source | Out-Null
    $candidate = Get-Item -LiteralPath $pending
    if (-not (Test-SourceTarget $candidate)) {
        throw "临时链接目标不符，停止并保留现场：$pending"
    }
    if ($existing) { Remove-Item -LiteralPath $alias }
    Move-Item -LiteralPath $pending -Destination $alias
}

foreach ($alias in $aliases) {
    $item = Get-Item -LiteralPath $alias
    if ($item.LinkType -ne 'SymbolicLink' -or
        -not (Test-SourceTarget $item) -or
        (Get-FileHash -LiteralPath $alias).Hash -ne (Get-FileHash -LiteralPath $source).Hash) {
        throw "转换后验证失败：$alias"
    }
}
$aliases | ForEach-Object { Get-Item -LiteralPath $_ } |
    Select-Object FullName, LinkType, Target
Write-Output 'PASS：三个文件软链接均指向唯一源文件，内容读取一致。'
