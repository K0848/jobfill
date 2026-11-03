"""真实 CLI / Windows 互斥量测试；全部写入 TemporaryDirectory，不操作正式跟进表。"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

SCRIPT = Path(__file__).resolve().parents[1] / 'tools/update-job-tracker.py'
spec = importlib.util.spec_from_file_location('tracker', SCRIPT)
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)


def fixture(path, status=''):
    headers = ['序号', '公司名称', '投递岗位', '投递时间', '投递/内推链接', '当前状态', '结果', '最新进展+日期', '书签备注']
    first = ''.join(t.cell_xml(chr(65 + i) + '1', v, '2') for i, v in enumerate(headers))
    cells = [t.cell_xml('A2', '1', '3', True), t.cell_xml('B2', '已有公司', '4'),
             t.cell_xml('C2', '产品经理', '4'), '<c r="D2" s="5"><f>1+2</f><v>3</v></c>',
             t.cell_xml('E2', 'https://example.com/job?id=1', '6'), t.cell_xml('F2', status, '3'),
             t.cell_xml('I2', '必须保留备注', '7')]
    parts = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
        'xl/workbook.xml': f'<workbook xmlns="{t.NS}" xmlns:r="{t.REL}"><sheets><sheet name="投递跟进" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': f'<Relationships xmlns="{t.PKG}"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="{t.REL}/worksheet"/></Relationships>',
        'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{t.NS}" xmlns:r="{t.REL}" xmlns:mc="urn:mc" xmlns:x="urn:extra" mc:Ignorable="x"><dimension ref="A1:I2"/><sheetData><row r="1">{first}</row><row r="2" ht="30" customHeight="1">{"".join(cells)}</row></sheetData><dataValidations count="1"><dataValidation sqref="F2:F999" type="list"><formula1>"筛选中,面试中"</formula1></dataValidation></dataValidations><pageMargins left="1" right="1" top="1" bottom="1" header="0" footer="0"/><extLst><ext uri="test"><x:keep/></ext></extLst></worksheet>',
        'xl/styles.xml': '<unchanged>styles sentinel</unchanged>',
        'xl/worksheets/sheet2.xml': '<unchanged>other sheet sentinel</unchanged>'}
    with zipfile.ZipFile(path, 'w') as z:
        for name, content in parts.items():
            z.writestr(name, content.encode())
    return {k: v.encode() for k, v in parts.items()}


def request(i=2, completed=True):
    return {'company': f'公司{i}', 'job': 'AI 产品经理', 'url': f'https://example.com/job?id={i}', 'completed': completed}


@unittest.skipUnless(os.name == 'nt', 'Windows 互斥量与共享模式')
class TrackerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'tracker.xlsx'
        self.original = fixture(self.path)

    def parts(self):
        with zipfile.ZipFile(self.path) as z:
            return {n: z.read(n) for n in z.namelist()}

    def replace_sheet(self, old, new):
        parts = self.parts()
        key = 'xl/worksheets/sheet1.xml'
        parts[key] = parts[key].decode().replace(old, new).encode()
        with zipfile.ZipFile(self.path, 'w') as z:
            for name, content in parts.items():
                z.writestr(name, content)

    def cell_snapshot(self):
        # 独立解析落盘 XML，不使用被测工具的单元格读取逻辑。
        root = ET.fromstring(self.parts()['xl/worksheets/sheet1.xml'])
        return {c.get('r'): ET.tostring(c) for c in root.findall(f'.//{{{t.NS}}}c')}

    def test_empty_status_variants_preserve_every_other_cell(self):
        for empty in ('<c r="F2" s="3"/>', '<c r="F2" s="3"></c>'):
            with self.subTest(empty=empty):
                fixture(self.path)
                self.replace_sheet(t.cell_xml('F2', '', '3'), empty +
                    '<c r="G2" s="5"><f>1+2</f><v>3</v></c>' +
                    '<c r="H2" s="4" t="inlineStr"><is><t>保留结果</t></is></c>')
                self.replace_sheet('</row></sheetData>', '<c r="J2" s="3"/><c r="K2" s="4"/></row></sheetData>')
                before = self.cell_snapshot()
                data = dict(company='已有公司', job='产品经理', url='https://example.com/job?id=1', completed=True)
                self.assertEqual(t.update(self.path, data)['status'], '筛选中')
                after = self.cell_snapshot()
                self.assertEqual(set(before), set(after))
                for ref in before.keys() - {'B2', 'C2', 'E2', 'F2'}:
                    self.assertEqual(before[ref], after[ref], ref)

    def test_literal_formula_link_deduplicates_and_converts_only_target(self):
        for formula in ('HYPERLINK("https://example.com/job?id=1","查看岗位")',
                        ' = hyperlink ( "https://example.com/job?id=1" , "查看""岗位" ) ',
                        'HYPERLINK("https://example.com/job?id=1")'):
            with self.subTest(formula=formula):
                fixture(self.path)
                self.replace_sheet(t.cell_xml('E2', 'https://example.com/job?id=1', '6'),
                    '<c r="E2" s="6" t="str"><f>' + escape(formula) + '</f><v>查看岗位</v></c>')
                before = self.cell_snapshot()
                data = dict(company='已有公司', job='产品经理', url='https://example.com/job?id=1', completed=True)
                self.assertEqual(t.update(self.path, data)['row'], 2)
                after = self.cell_snapshot()
                self.assertEqual(set(before), set(after))
                for ref in before.keys() - {'B2', 'C2', 'E2', 'F2'}:
                    self.assertEqual(before[ref], after[ref], ref)
                root = ET.fromstring(self.parts()['xl/worksheets/sheet1.xml'])
                cell = root.find(f'.//{{{t.NS}}}c[@r="E2"]')
                self.assertIsNone(cell.find(f'{{{t.NS}}}f'))
                self.assertEqual(''.join(cell.itertext()), data['url'])
                saved = self.parts()
                self.assertEqual(t.update(self.path, data)['row'], 2)
                self.assertEqual(saved, self.parts())

    def test_unresolved_link_formula_stops_without_changing_file(self):
        for formula in ('HYPERLINK(A2,"查看岗位")',
                        'HYPERLINK("https://example.com/"&A2,"查看岗位")',
                        'IF(A2,HYPERLINK("https://example.com/job?id=1","查看岗位"),"")'):
            with self.subTest(formula=formula):
                fixture(self.path)
                self.replace_sheet(t.cell_xml('E2', 'https://example.com/job?id=1', '6'),
                    '<c r="E2" t="str"><f>' + escape(formula) + '</f><v>查看岗位</v></c>')
                before = self.path.read_bytes()
                with self.assertRaisesRegex(ValueError, '公式'):
                    t.update(self.path, request())
                self.assertEqual(before, self.path.read_bytes())

    def test_other_target_formula_is_not_overwritten(self):
        self.replace_sheet(t.cell_xml('B2', '已有公司', '4'),
            '<c r="B2" t="str"><f>"已有公司"</f><v>已有公司</v></c>')
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, '公式'):
            t.update(self.path, dict(company='已有公司', job='产品经理', url='https://example.com/job?id=1', completed=True))
        self.assertEqual(before, self.path.read_bytes())

    def test_shared_and_array_formula_links_leave_original_unchanged(self):
        for attrs, formula in (
                ('t="shared" si="0" ref="E2:E3"', 'HYPERLINK("https://example.com/job?id=1","查看岗位")'),
                ('t="shared" si="0"', ''),
                ('t="array" ref="E2:E3"', 'HYPERLINK("https://example.com/job?id=1","查看岗位")'),
                ('t="dataTable" ref="E2:E3"', '')):
            with self.subTest(attrs=attrs):
                fixture(self.path)
                self.replace_sheet(t.cell_xml('E2', 'https://example.com/job?id=1', '6'),
                    f'<c r="E2" t="str"><f {attrs}>{escape(formula)}</f><v>查看岗位</v></c>')
                before = self.path.read_bytes()
                with self.assertRaisesRegex(ValueError, '公式'):
                    t.update(self.path, request())
                self.assertEqual(before, self.path.read_bytes())

    def test_formula_conversion_invalidates_excel_calculation_chain(self):
        self.replace_sheet(t.cell_xml('E2', 'https://example.com/job?id=1', '6'),
            '<c r="E2" t="str"><f>HYPERLINK("https://example.com/job?id=1","查看岗位")</f><v>查看岗位</v></c>')
        parts = self.parts()
        key = 'xl/_rels/workbook.xml.rels'
        parts[key] = parts[key].replace(b'</Relationships>',
            f'<Relationship Id="calc1" Target="calcChain.xml" Type="{t.REL}/calcChain"/></Relationships>'.encode())
        parts['[Content_Types].xml'] = parts['[Content_Types].xml'].replace(b'</Types>',
            b'<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>')
        parts['xl/calcChain.xml'] = f'<calcChain xmlns="{t.NS}"><c r="E2" i="1"/><c r="D2" i="1"/></calcChain>'.encode()
        with zipfile.ZipFile(self.path, 'w') as z:
            for name, content in parts.items():
                z.writestr(name, content)
        t.update(self.path, dict(company='已有公司', job='产品经理', url='https://example.com/job?id=1', completed=True))
        after = self.parts()
        self.assertNotIn('xl/calcChain.xml', after)
        self.assertFalse(any(r.get('Type', '').endswith('/calcChain') for r in ET.fromstring(after[key])))
        self.assertFalse(any(r.get('PartName') == '/xl/calcChain.xml' for r in ET.fromstring(after['[Content_Types].xml'])))
        root = ET.fromstring(after['xl/worksheets/sheet1.xml'])
        self.assertEqual(root.findtext(f'.//{{{t.NS}}}c[@r="D2"]/{{{t.NS}}}f'), '1+2')

    def test_non_target_hyperlink_is_preserved(self):
        self.replace_sheet('<pageMargins',
            '<hyperlinks><hyperlink ref="E2" location="old"/><hyperlink ref="I2" location="Sheet2!A1"></hyperlink></hyperlinks><pageMargins')
        t.update(self.path, dict(company='已有公司', job='产品经理', url='https://example.com/job?id=1', completed=True))
        root = ET.fromstring(self.parts()['xl/worksheets/sheet1.xml'])
        link = root.find(f'{{{t.NS}}}hyperlinks/{{{t.NS}}}hyperlink[@ref="I2"]')
        self.assertIsNotNone(link)
        self.assertEqual(link.get('location'), 'Sheet2!A1')

    def start(self, i, data):
        req = Path(self.tmp.name) / f'{i}.json'
        req.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        return subprocess.Popen([sys.executable, '-B', str(SCRIPT), '--workbook', str(self.path), '--request-file', str(req)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_concurrent_cli_and_repeat_are_idempotent(self):
        processes = [self.start(i, request(i)) for i in [2, 3, 4, 5]]
        results = [(p, p.communicate(timeout=20)) for p in processes]
        for p, (out, err) in results:
            self.assertEqual(p.returncode, 0, err)
        before = self.parts()
        p = self.start('repeat', request(2))
        p.communicate(timeout=20)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(before, self.parts())
        _, _, root, rows, _, cols, strings = t.inspect_book(self.parts())
        self.assertEqual(len(rows), 6)
        self.assertEqual(len(root.findall(f'{{{t.NS}}}hyperlinks/{{{t.NS}}}hyperlink')), 4)
        statuses = [t.cell_value(root.find(f'.//{{{t.NS}}}c[@r="F{n}"]'), strings) for n in range(3, 7)]
        self.assertEqual(statuses, ['筛选中'] * 4)

    def test_preserves_other_parts_formula_validation_and_styles(self):
        result = t.update(self.path, request())
        self.assertEqual(result['row'], 3)
        after = self.parts()
        for name in self.original:
            if name != 'xl/worksheets/sheet1.xml':
                self.assertEqual(after[name], self.original[name])
        xml = after['xl/worksheets/sheet1.xml'].decode()
        self.assertIn('<c r="D2" s="5"><f>1+2</f><v>3</v></c>', xml)
        self.assertIn('xmlns:x="urn:extra" mc:Ignorable="x"', xml)
        self.assertIn('必须保留备注', xml)
        self.assertIn('sqref="F2:F999"', xml)
        self.assertIn('<c r="E3" s="6"', xml)
        root = ET.fromstring(xml)
        for ref, style in [('D3', '5'), ('I3', '7')]:
            cell = root.find(f'.//{{{t.NS}}}c[@r="{ref}"]')
            self.assertEqual(cell.get('s'), style)
            self.assertEqual(t.cell_value(cell, []), '')
            self.assertIsNone(cell.find(f'{{{t.NS}}}f'))
        rel = ET.fromstring(after['xl/worksheets/_rels/sheet1.xml.rels'])
        self.assertEqual(rel[0].get('Target'), request()['url'])

    def test_later_status_and_incomplete(self):
        fixture(self.path, '面试中')
        data = {'company': '已有公司', 'job': '产品经理', 'url': 'https://example.com/job?id=1&userId=abc', 'completed': True}
        self.assertEqual(t.update(self.path, data)['status'], '面试中')
        self.assertEqual(t.update(self.path, request(2, False))['status'], '')
        self.assertEqual(t.update(self.path, request(2, True))['status'], '筛选中')
        self.assertEqual(t.update(self.path, request(2, False))['status'], '筛选中')

    def test_distinct_links_same_company_job_are_not_merged(self):
        a = request(2)
        b = dict(a, url='https://example.com/job?id=3')
        self.assertNotEqual(t.update(self.path, a)['row'], t.update(self.path, b)['row'])

    def test_job_id_deduplicates_route_and_tracking_but_not_other_ids(self):
        data = dict(request(2), url='https://company.zhiye.com/job/detail?jobAdId=123&userId=abc&fromPage=list')
        first = t.update(self.path, data)
        same = dict(data, url='https://company.zhiye.com/apply?jobAdId=123&userId=def&fromPage=home')
        self.assertEqual(t.update(self.path, same)['row'], first['row'])
        different = dict(data, url='https://company.zhiye.com/job/detail?jobAdId=456')
        self.assertNotEqual(t.update(self.path, different)['row'], first['row'])
        self.assertNotEqual(t.identity('https://example.com/#/jobs/1'), t.identity('https://example.com/#/jobs/2'))

    def test_conflicting_company_or_job_for_same_url_is_rejected(self):
        t.update(self.path, request(2))
        before = self.path.read_bytes()
        for key in ('company', 'job'):
            with self.assertRaisesRegex(ValueError, '冲突'):
                t.update(self.path, dict(request(2), **{key: '不同名称'}))
            self.assertEqual(self.path.read_bytes(), before)

    def test_occupied_marker_and_sharing_fail_without_write(self):
        before = self.path.read_bytes()
        marker = self.path.with_name('~$' + self.path.name)
        marker.write_text('occupied')
        with self.assertRaises(PermissionError):
            t.update(self.path, request())
        marker.unlink()
        k = t.kernel()
        handle = k.CreateFileW(str(self.path), 0xC0000000, 1, None, 3, 0, None)
        try:
            with self.assertRaises(OSError):
                t.update(self.path, request())
        finally:
            k.CloseHandle(handle)
        self.assertEqual(before, self.path.read_bytes())

    def test_replace_failure_and_validation_leave_original(self):
        before = self.path.read_bytes()
        with patch.object(t.os, 'replace', side_effect=PermissionError('occupied')):
            with self.assertRaises(PermissionError):
                t.update(self.path, request())
        self.assertEqual(before, self.path.read_bytes())
        self.assertFalse(list(self.path.parent.glob('.jobfill-*')))
        with self.assertRaises(ValueError):
            t.update(self.path, dict(request(), completed='true'))

    def test_mutex_timeout(self):
        with t.workbook_lock(self.path.resolve(), 1):
            req = Path(self.tmp.name) / 'lock.json'
            req.write_text(json.dumps(request()), encoding='utf-8')
            p = subprocess.run([sys.executable, '-B', str(SCRIPT), '--workbook', str(self.path), '--request-file', str(req), '--lock-timeout', '0.05'], capture_output=True, timeout=10)
            self.assertEqual(p.returncode, 1)
        self.assertEqual(t.update(self.path, request())['status'], '筛选中')

    def test_abandoned_mutex_is_recovered(self):
        code = ('import importlib.util,os; '
                f's=importlib.util.spec_from_file_location("t",{str(SCRIPT)!r}); '
                't=importlib.util.module_from_spec(s); s.loader.exec_module(t); '
                f'c=t.workbook_lock(t.Path({str(self.path)!r}).resolve(),1); '
                'c.__enter__(); print("locked",flush=True); os._exit(0)')
        p = subprocess.run([sys.executable, '-B', '-c', code], capture_output=True, timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(t.update(self.path, request())['status'], '筛选中')

    def test_external_replacement_blocked_during_build(self):
        original_patch = t.patch_book
        foreign = self.path.read_bytes() + b'external edit'
        def interfere(parts, data):
            result = original_patch(parts, data)
            # 模拟不遵守互斥量、用替换文件方式写入的外部工具。
            other = self.path.with_name('external.xlsx')
            other.write_bytes(foreign)
            # 持有 deny-write 句柄时 Windows 同样拒绝替换，验证该路径无覆盖。
            with self.assertRaises(PermissionError):
                os.replace(other, self.path)
            other.unlink()
            return result
        with patch.object(t, 'patch_book', side_effect=interfere):
            self.assertEqual(t.update(self.path, request())['status'], '筛选中')


if __name__ == '__main__':
    unittest.main()
