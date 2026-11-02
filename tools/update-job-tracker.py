"""单机 Windows 网申跟进表更新入口；仅依赖 Python 标准库。

python tools/update-job-tracker.py --workbook PATH --request-file request.json
request: {"company":"公司", "job":"岗位", "url":"https://...", "completed":true}
"""
import argparse
import contextlib
import ctypes
from ctypes import wintypes
import hashlib
import io
import json
import os
from pathlib import Path
import posixpath
import re
import sys
import tempfile
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape, quoteattr
import zipfile
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'
HEADERS = {'company': ('公司名称', '公司'), 'job': ('投递岗位', '岗位'),
           'url': ('投递/内推链接', '职位链接'), 'status': ('当前状态',), 'serial': ('序号',)}


def validate_request(data):
    if not isinstance(data, dict) or set(data) != {'company', 'job', 'url', 'completed'}:
        raise ValueError('请求须且仅须包含 company、job、url、completed')
    for key in ('company', 'job', 'url'):
        value = data[key]
        if not isinstance(value, str) or not value.strip() or len(value) > 32767:
            raise ValueError(f'{key} 必须是非空字符串且不超过 Excel 单元格长度')
        if re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', value):
            raise ValueError(f'{key} 含 XML 不支持的控制字符')
        data[key] = value.strip()
    if type(data['completed']) is not bool:
        raise ValueError('completed 必须是 JSON 布尔值')
    u = urlsplit(data['url'])
    if u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password:
        raise ValueError('url 必须是无登录凭据的 HTTP(S) 职位链接')
    return data


def identity(url):
    u = urlsplit(url.strip())
    # 招聘站以明确职位 ID 标识同一职位；详情页与申请页路径、来源参数可不同。
    ids = [(k.lower(), v) for k, v in parse_qsl(u.query, keep_blank_values=True)
           if k.lower() in ('jobadid', 'jobid') and v]
    if len(ids) == 1:
        return (u.netloc.lower(), ids[0][0], ids[0][1])
    # 只剔除明确的跟踪参数，不把不同职位链接按公司/岗位名称合并。
    pairs = [(k, v) for k, v in parse_qsl(u.query, keep_blank_values=True)
             if not k.lower().startswith('utm_') and k.lower() not in ('userid', 'from', 'source', 'spm')]
    # fragment 可能包含单页应用的职位路径，必须保留。
    return urlunsplit((u.scheme.lower(), u.netloc.lower(), u.path.rstrip('/'), urlencode(sorted(pairs)), u.fragment))


def kernel():
    if os.name != 'nt':
        raise RuntimeError('此入口仅支持本机 Windows，不能跨机器协调写入')
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    k.CreateMutexW.restype = wintypes.HANDLE
    k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k.WaitForSingleObject.restype = wintypes.DWORD
    k.ReleaseMutex.argtypes = [wintypes.HANDLE]
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    k.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    k.CreateFileW.restype = wintypes.HANDLE
    return k


@contextlib.contextmanager
def workbook_lock(path, timeout):
    k = kernel()
    # 路径摘要仅用来命名跨进程互斥量；系统自动回收崩溃进程的锁，无持久锁文件。
    name = 'Local\\JobfillTracker_' + hashlib.sha256(os.path.normcase(str(path)).encode()).hexdigest()
    handle = k.CreateMutexW(None, False, name)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    owned = False
    try:
        result = k.WaitForSingleObject(handle, int(timeout * 1000))
        if result == 258:
            raise TimeoutError('跟进表正在由其他聊天更新，等待超时；可重试')
        if result not in (0, 128):  # WAIT_ABANDONED 表示前一进程中断，现已取得锁。
            raise ctypes.WinError(ctypes.get_last_error())
        owned = True
        yield
    finally:
        if owned:
            k.ReleaseMutex(handle)
        k.CloseHandle(handle)


@contextlib.contextmanager
def deny_external_writes(path):
    if path.with_name('~$' + path.name).exists():
        raise PermissionError('检测到 Excel 占用标记，请关闭工作簿后重试；不自动删除标记')
    k = kernel()
    # 构建临时文件期间拒绝外部写句柄。Windows 替换目标前必须关闭此读句柄；
    # 最终替换仍由系统检查其他程序的共享模式，互斥量在整个事务中保持。
    h = k.CreateFileW(str(path), 0x80000000, 1 | 4, None, 3, 0, None)
    if h == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    def release():
        nonlocal h
        if h is not None:
            k.CloseHandle(h)
            h = None
    try:
        yield release
    finally:
        release()


def cell_value(c, strings):
    if c is None:
        return ''
    if c.get('t') == 'inlineStr':
        return ''.join(c.itertext())
    value = c.findtext(f'{{{NS}}}v', '')
    return strings[int(value)] if c.get('t') == 's' and value else value


def inspect_book(parts):
    strings = []
    if 'xl/sharedStrings.xml' in parts:
        strings = [''.join(si.itertext()) for si in ET.fromstring(parts['xl/sharedStrings.xml'])]
    relations = {r.get('Id'): r.get('Target') for r in ET.fromstring(parts['xl/_rels/workbook.xml.rels'])}
    found = []
    for sheet in ET.fromstring(parts['xl/workbook.xml']).find(f'{{{NS}}}sheets'):
        target = relations[sheet.get(f'{{{REL}}}id')]
        path = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/' + target)
        root = ET.fromstring(parts[path])
        rows = root.findall(f'{{{NS}}}sheetData/{{{NS}}}row')
        for row in rows[:10]:
            values = {cell_value(c, strings): re.sub(r'\d+', '', c.get('r')) for c in row}
            cols = {key: next((values[h] for h in names if h in values), None) for key, names in HEADERS.items()}
            if all(cols[k] for k in ('company', 'job', 'url', 'status')):
                found.append((sheet.get('name'), path, root, rows, int(row.get('r')), cols, strings))
                break
    if len(found) != 1:
        raise ValueError('无法唯一定位含公司、岗位、链接、当前状态表头的工作表')
    return found[0]


def cell_xml(ref, value, style=None, numeric=False):
    s = f' s={quoteattr(style)}' if style is not None else ''
    if numeric:
        return f'<c r="{ref}"{s}><v>{value}</v></c>'
    return f'<c r="{ref}"{s} t="inlineStr"><is><t xml:space="preserve">{escape(value)}</t></is></c>'


def patch_book(parts, request):
    name, path, root, rows, header, cols, strings = inspect_book(parts)
    # 精确文本替换保留根命名空间、扩展、验证、公式及未改单元格，避免 XML 重序列化丢失 mc 前缀。
    xml = parts[path].decode('utf-8')
    if not re.search(r'<worksheet\b', xml) or '<sheetData>' not in xml:
        raise ValueError('暂不支持带前缀或空 sheetData 的工作表 XML，请勿转换原文件')
    relpath = posixpath.dirname(path) + '/_rels/' + posixpath.basename(path) + '.rels'
    relxml = parts.get(relpath, f'<Relationships xmlns="{PKG}"></Relationships>'.encode()).decode('utf-8')
    relroot = ET.fromstring(relxml)
    targets = {r.get('Id'): r.get('Target') for r in relroot}
    links = {h.get('ref'): targets.get(h.get(f'{{{REL}}}id'), '') for h in root.findall(f'{{{NS}}}hyperlinks/{{{NS}}}hyperlink')}
    matches, fallback = [], []
    data_rows = [r for r in rows if int(r.get('r')) > header]
    for row in data_rows:
        rn = int(row.get('r'))
        cells = {c.get('r'): c for c in row}
        get = lambda key: cell_value(cells.get(cols[key] + str(rn)), strings)
        url = links.get(cols['url'] + str(rn)) or get('url')
        if url and identity(url) == identity(request['url']):
            if get('company') != request['company'] or get('job') != request['job']:
                raise ValueError('职位链接匹配，但公司或岗位名称冲突；请先核对，不覆盖已有记录')
            matches.append(row)
        elif not url and get('company') == request['company'] and get('job') == request['job']:
            fallback.append(row)
    candidates = matches or fallback
    if len(candidates) > 1:
        raise ValueError('存在多条匹配岗位，拒绝猜测或合并；请先核对重复记录')
    existing = candidates[0] if candidates else None
    new = existing is None
    rn = max([int(r.get('r')) for r in rows]) + 1 if new else int(existing.get('r'))
    template = data_rows[-1] if data_rows else None
    styles = {re.sub(r'\d+', '', c.get('r')): c.get('s') for c in (template if template is not None else [])}
    cells = {c.get('r'): c for c in existing} if existing is not None else {}
    old_status = cell_value(cells.get(cols['status'] + str(rn)), strings)
    status = old_status or ('筛选中' if request['completed'] else '')
    values = {cols[k]: request[k] for k in ('company', 'job', 'url')}
    if not old_status:
        values[cols['status']] = status
    if new and cols['serial']:
        serials = [cell_value(next((c for c in r if c.get('r') == cols['serial'] + r.get('r')), None), strings) for r in data_rows]
        values[cols['serial']] = str(max([int(v) for v in serials if v.isdigit()] or [0]) + 1)
    if new:
        # 其他列保留上一行的单元格样式，但不继承日期、备注、结果或公式。
        for col in styles:
            values.setdefault(col, '')
    if new:
        attrs = ''.join(f' {k}={quoteattr(v)}' for k, v in (template.attrib.items() if template is not None else [])
                        if k in ('s', 'customFormat', 'ht', 'customHeight', 'spans'))
        rowxml = f'<row r="{rn}"{attrs}></row>'
    else:
        rowmatch = re.search(r'<row\b[^>]*\br=["\']' + str(rn) + r'["\'][^>]*(?:/>|>.*?</row>)', xml, re.S)
        if not rowmatch:
            raise ValueError('无法定位目标行 XML')
        rowxml = rowmatch.group()
    for col, value in values.items():
        ref = col + str(rn)
        old = cells.get(ref)
        if old is not None and old.find(f'{{{NS}}}f') is not None:
            raise ValueError(f'{ref} 存在公式，拒绝覆盖')
        replacement = cell_xml(ref, value, old.get('s') if old is not None else styles.get(col), new and col == cols['serial'])
        pattern = r'<c\b[^>]*\br=["\']' + ref + r'["\'][^>]*(?:/>|>.*?</c>)'
        if re.search(pattern, rowxml, re.S):
            rowxml = re.sub(pattern, lambda _: replacement, rowxml, count=1, flags=re.S)
        else:
            rowxml = rowxml.replace('</row>', replacement + '</row>')
    # 单元格按列排序，未改动单元格的原始 XML 不变。
    cell_chunks = re.findall(r'<c\b[^>]*(?:/>|>.*?</c>)', rowxml, re.S)
    def column_number(chunk):
        col = re.search(r'\br=["\']([A-Z]+)\d+', chunk).group(1)
        n = 0
        for ch in col:
            n = n * 26 + ord(ch) - 64
        return n
    rowxml = re.sub(r'(<row\b[^>]*>).*?(</row>)', lambda m: m[1] + ''.join(sorted(cell_chunks, key=column_number)) + m[2], rowxml, flags=re.S)
    xml = xml.replace('</sheetData>', rowxml + '</sheetData>', 1) if new else xml[:rowmatch.start()] + rowxml + xml[rowmatch.end():]
    if new:
        def extend(m):
            return m[0].replace(m[1], re.sub(r'\d+$', str(rn), m[1])) if int(re.search(r'\d+$', m[1])[0]) < rn else m[0]
        xml = re.sub(r'<(?:dimension|autoFilter)\b[^>]*\bref="([A-Z]+\d+:[A-Z]+\d+)"[^>]*>', extend, xml)
        if root.find(f'{{{NS}}}tableParts') is not None:
            raise ValueError('检测到 Excel 表对象；此版本不自动扩表，请先扩展支持')
    ref = cols['url'] + str(rn)
    rid = next((key for key, value in targets.items() if value == request['url']), None)
    reuse = rid is not None
    rid = rid or 'jobfillLink1'
    i = 1
    while not reuse and rid in targets:
        i += 1
        rid = f'jobfillLink{i}'
    relationship = f'<Relationship Id="{rid}" Type="{REL}/hyperlink" Target={quoteattr(request["url"])} TargetMode="External"/>'
    if '</Relationships>' not in relxml:
        relxml = re.sub(r'<Relationships\b([^>]*)/>', r'<Relationships\1></Relationships>', relxml)
    if not reuse:
        relxml = relxml.replace('</Relationships>', relationship + '</Relationships>')
    hyperlink = f'<hyperlink xmlns:r="{REL}" ref="{ref}" r:id="{rid}"/>'
    pattern = r'<hyperlink\b[^>]*\bref=["\']' + ref + r'["\'][^>]*(?:/>|>.*?</hyperlink>)'
    if re.search(pattern, xml, re.S):
        # 保留旧 relationship 无害，避免误删被其他单元格复用的链接。
        xml = re.sub(pattern, lambda _: hyperlink, xml, count=1, flags=re.S)
    elif '</hyperlinks>' in xml:
        xml = xml.replace('</hyperlinks>', hyperlink + '</hyperlinks>')
    else:
        xml = re.sub(r'<hyperlinks\s*/>', '', xml)
        # hyperlinks 位于验证之后、打印设置之前；按 OOXML 子元素顺序插入。
        after = ('printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst')
        m = re.search(r'<(?:' + '|'.join(after) + r')\b|</worksheet>', xml)
        xml = xml[:m.start()] + '<hyperlinks>' + hyperlink + '</hyperlinks>' + xml[m.start():]
    parts[path] = xml.encode('utf-8')
    parts[relpath] = relxml.encode('utf-8')
    return {'sheet': name, 'row': rn, 'action': 'inserted' if new else 'updated', 'status': status,
            'company': request['company'], 'job': request['job'], 'url': request['url'], 'readback': 'matched'}, path, relpath


def update(workbook, request, timeout=30):
    request = validate_request(dict(request))
    path = Path(workbook).resolve(strict=True)
    if path.suffix.lower() != '.xlsx':
        raise ValueError('只支持 .xlsx 工作簿')
    with workbook_lock(path, timeout), deny_external_writes(path) as release_guard:
        before = path.read_bytes()  # 必须在取得锁之后读取。
        with zipfile.ZipFile(io.BytesIO(before)) as source:
            infos = source.infolist()
            parts = {info.filename: source.read(info) for info in infos}
            comment = source.comment
        result, sheetpath, relpath = patch_book(parts, request)
        for name in (sheetpath, relpath):
            ET.fromstring(parts[name])
        fd, tempname = tempfile.mkstemp(prefix='.jobfill-', suffix='.xlsx', dir=path.parent)
        temp = Path(tempname)
        try:
            with os.fdopen(fd, 'wb') as out:
                with zipfile.ZipFile(out, 'w') as target:
                    target.comment = comment
                    for info in infos:
                        target.writestr(info, parts.pop(info.filename))
                    for name, content in parts.items():
                        target.writestr(name, content, compress_type=zipfile.ZIP_DEFLATED)
                out.flush()
                os.fsync(out.fileno())
            with zipfile.ZipFile(temp) as check:
                if check.testzip() is not None:
                    raise ValueError('生成文件 ZIP 完整性验证失败')
                verified = {n: check.read(n) for n in check.namelist()}
                _, _, root, _, _, cols, strings = inspect_book(verified)
                for key in ('company', 'job', 'url'):
                    c = root.find(f'.//{{{NS}}}c[@r="{cols[key]}{result["row"]}"]')
                    if cell_value(c, strings) != request[key]:
                        raise ValueError('生成文件字段读回失败')
                status_cell = root.find(f'.//{{{NS}}}c[@r="{cols["status"]}{result["row"]}"]')
                if cell_value(status_cell, strings) != result['status']:
                    raise ValueError('生成文件状态读回失败')
                link = root.find(f'{{{NS}}}hyperlinks/{{{NS}}}hyperlink[@ref="{cols["url"]}{result["row"]}"]')
                relations = {r.get('Id'): r.get('Target') for r in ET.fromstring(verified[relpath])}
                if link is None or relations.get(link.get(f'{{{REL}}}id')) != request['url']:
                    raise ValueError('生成文件真实超链接读回失败')
            if path.read_bytes() != before or path.with_name('~$' + path.name).exists():
                raise RuntimeError('写入期间原文件发生变化或被 Excel 打开，未覆盖，请重试')
            release_guard()
            if path.read_bytes() != before:
                raise RuntimeError('替换前原文件发生变化，未覆盖，请重试')
            os.replace(temp, path)
            verify_saved(verified, path)
            return result
        finally:
            if temp.exists():
                temp.unlink()  # 只清理本次 mkstemp 创建的临时文件。


def verify_saved(expected_parts, path):
    saved = path.read_bytes()
    with zipfile.ZipFile(io.BytesIO(saved)) as archive:
        if {n: archive.read(n) for n in archive.namelist()} != expected_parts:
            raise RuntimeError('保存后工作簿内容与已验证文件不一致')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workbook', required=True)
    parser.add_argument('--request-file', required=True)
    parser.add_argument('--lock-timeout', type=float, default=30)
    args = parser.parse_args()
    try:
        if not 0 <= args.lock_timeout <= 300:
            raise ValueError('lock-timeout 必须在 0 到 300 秒之间')
        with open(args.request_file, encoding='utf-8-sig') as f:
            request = json.load(f)
        print(json.dumps(update(args.workbook, request, args.lock_timeout), ensure_ascii=False))
        return 0
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, ET.ParseError) as exc:
        print(json.dumps({'error': str(exc), 'success': False}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
