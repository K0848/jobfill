param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path ([IO.Path]::GetTempPath()) ('jobfill-excel-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($dir) | Out-Null
$file = Join-Path $dir 'fixture.xlsx'
$request = Join-Path $dir 'request.json'
$app = $null; $book = $null; $sheet = $null
try {
    # 使用独立隐藏 Excel 实例，既不连接用户工作簿，也不复用真实数据。
    $app = New-Object -ComObject Excel.Application
    $app.Visible = $false; $app.DisplayAlerts = $false
    $book = $app.Workbooks.Add(); $sheet = $book.Worksheets.Item(1)
    $sheet.Name = '投递跟进'
    $headers = @('序号','公司名称','投递岗位','投递时间','投递/内推链接','当前状态','结果','最新进展+日期','书签备注')
    for ($i=0;$i -lt $headers.Count;$i++) { $sheet.Cells.Item(1,$i+1).Value2 = $headers[$i] }
    $sheet.Range('A2').Value2 = 1
    $sheet.Range('B2').Value2 = '测试公司'
    $sheet.Range('C2').Value2 = '测试岗位'
    $sheet.Range('D2').Formula = '=1+2'
    $sheet.Range('E2').Formula = '=HYPERLINK("https://example.com/jobs/1","查看岗位")'
    $sheet.Range('F2').NumberFormat = '@'
    $sheet.Range('G2').Value2 = '保持结果'
    $sheet.Range('H2').Formula = '=SUM(4,5)'
    $sheet.Range('I2').Value2 = '保持备注'
    $sheet.Range('I2').Interior.Color = 65535
    $sheet.Range('A3').Value2 = 2
    $sheet.Range('B3').Value2 = '另一公司'
    $sheet.Range('C3').Value2 = '另一岗位'
    $sheet.Range('E3').Value2 = 'https://example.com/jobs/2'
    $book.SaveAs($file, 51); $book.Close($false)
    [Runtime.InteropServices.Marshal]::ReleaseComObject($sheet) | Out-Null; $sheet=$null
    [Runtime.InteropServices.Marshal]::ReleaseComObject($book) | Out-Null; $book=$null
    [IO.File]::WriteAllText($request, (@{company='测试公司';job='测试岗位';url='https://example.com/jobs/1';completed=$true} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    foreach ($attempt in 1..2) {
        $output = & $Python -X utf8 -B (Join-Path $root 'tools/update-job-tracker.py') --workbook $file --request-file $request
        if ($LASTEXITCODE -ne 0) { throw "更新工具执行失败：$output" }
        $result = $output | ConvertFrom-Json
        if ($result.row -ne 2 -or $result.action -ne 'updated') { throw '公式链接未在原行去重' }
    }
    # 用原生 Excel 独立读回，验证实际文件而非复用更新工具的解析结果。
    $book = $app.Workbooks.Open($file, 0, $true); $sheet=$book.Worksheets.Item(1)
    if ($sheet.UsedRange.Rows.Count -ne 3 -or $sheet.Range('F2').Value2 -ne '筛选中') { throw '行数或状态不正确' }
    if ($sheet.Range('G2').Value2 -ne '保持结果' -or $sheet.Range('I2').Value2 -ne '保持备注') { throw '无关内容发生变化' }
    if ($sheet.Range('D2').Formula -ne '=1+2' -or $sheet.Range('H2').Formula -ne '=SUM(4,5)' -or $sheet.Range('I2').Interior.Color -ne 65535) { throw '无关公式或格式发生变化' }
    if ($sheet.Range('E2').Value2 -ne 'https://example.com/jobs/1' -or $sheet.Range('E2').Hyperlinks.Item(1).Address -ne 'https://example.com/jobs/1') { throw '原生超链接目标错误' }
    Write-Output 'PASS Excel-created workbook: normal reopen, formula URL dedup, status, adjacent values/formulas/styles and native hyperlink preserved.'
} finally {
    if ($book) { $book.Close($false) }
    if ($sheet) { [Runtime.InteropServices.Marshal]::ReleaseComObject($sheet) | Out-Null }
    if ($book) { [Runtime.InteropServices.Marshal]::ReleaseComObject($book) | Out-Null }
    if ($app) { $app.Quit(); [Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null }
    # 仅清理本测试创建的两个文件和空目录，不递归触碰任何真实工作簿。
    foreach ($p in @($file,$request)) { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p } }
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir }
}
