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
