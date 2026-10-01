#!/usr/bin/env python3
"""Восстановить закреплённый архив из всех исходных байтов без перезаписи."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile

ORIGINAL_BYTES = 44790883
ORIGINAL_SHA256 = '298745c674a4f2f9eabbb24abe9ccf82e7d9e467e9f5492b4ee5ce9e59b260f7'
ORIGINAL_GIT = '5becf6dab5ef9aa4ae3d340818e3811c01b583bc'
DECODED_BYTES = 934439111
DECODED_SHA256 = '15104fb3226920a8db37133ede193be3fa67f21c99bd7f579002aa6266a0b678'
PREFIX = '.review-evidence/production-20261001/primary/segments/' + ORIGINAL_SHA256 + '/'
PART_LENGTHS = (20971520, 20971520, 2847843)
PART_SHA256 = ('f63b24c1780b2763441b2dbf3fbb743270b18079cf7799c3c1eec6b30508b6d6',
               'f8ff3a3bd6a8544eefcb8f34db4657303fbe35fa23f36b7df72c4f0375bfdc97',
               '3833615ec6ff35219c547d7ac330f772a24a77c44978115f3b36748974b39d03')
PART_GIT = ('2b41d5dcd78f59fc1e14d06eba34ed07f00595d1',
            '2d118d6978f3ce3c3ba9fad9916e1f8d3f547120',
            'b949dae3310886064f821598f308c20e60e4e179')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_recipe(recipe):
    require(isinstance(recipe, dict), 'Нужен объект карты частей')
    require(recipe.get('schemaVersion') == 1 and recipe.get('recipe') ==
            'contiguous-gzip-byte-slices-20MiB-v1', 'Неизвестный формат частей')
    require(recipe.get('proposalOnly') is False and recipe.get('consumable') is True,
            'Проект карты ещё не допущен к восстановлению')
    require(recipe.get('storagePartMaxBytes') == 20971520, 'Неверный предел части')
    original = recipe.get('original', {})
    require(original.get('bytes') == ORIGINAL_BYTES and original.get('sha256') == ORIGINAL_SHA256
            and original.get('reconstructedGitBlob') == ORIGINAL_GIT, 'Подменён исходный архив')
    decoded = original.get('decodedIdentity', {})
    require(decoded.get('bytes') == DECODED_BYTES and decoded.get('sha256') == DECODED_SHA256,
            'Подменена историческая распакованная идентичность')
    rows = recipe.get('parts')
    require(isinstance(rows, list) and len(rows) == 3, 'Нужны ровно три части')
    offset = 0
    for index, row in enumerate(rows):
        require(isinstance(row, dict), 'Неверная запись части')
        path = row.get('storagePath')
        require(isinstance(path, str) and not PurePosixPath(path).is_absolute()
                and '..' not in PurePosixPath(path).parts, 'Неверный относительный путь')
        require(type(row.get('index')) is int and row['index'] == index
                and type(row.get('offset')) is int and row['offset'] == offset
                and type(row.get('bytes')) is int and row['bytes'] == PART_LENGTHS[index],
                'Нарушены порядок, смещение или размер части')
        require(path == PREFIX + 'part-' + str(index).zfill(6) + '.bin', 'Подменён путь части')
        require(row.get('sha256') == PART_SHA256[index] and row.get('gitBlob') == PART_GIT[index],
                'Подменена закреплённая идентичность части')
        offset += row['bytes']
    require(offset == ORIGINAL_BYTES, 'Потеряны байты исходного архива')
    return rows


def hydrate(recipe, open_part, output):
    rows = validate_recipe(recipe)
    output = Path(output)
    require(not os.path.lexists(output), 'Итоговый путь уже существует')
    require(output.parent.is_dir(), 'Создайте собственный каталог для результата')
    whole, git = hashlib.sha256(), hashlib.sha1(('blob ' + str(ORIGINAL_BYTES) + '\0').encode())
    total, completed, temporary = 0, [], None
    try:
        # Собственный временный файл; готовое имя появляется только после всех проверок.
        with tempfile.NamedTemporaryFile(mode='wb', dir=output.parent,
                                         prefix='.' + output.name + '.', delete=False) as sink:
            temporary = Path(sink.name)
            for row in rows:
                digest = hashlib.sha256()
                oid = hashlib.sha1(('blob ' + str(row['bytes']) + '\0').encode())
                count = 0
                with open_part(row) as stream:
                    while block := stream.read(1024 * 1024):
                        count += len(block)
                        require(count <= row['bytes'], 'Часть содержит лишние байты')
                        digest.update(block)
                        oid.update(block)
                        whole.update(block)
                        git.update(block)
                        sink.write(block)
                require(count == row['bytes'] and digest.hexdigest() == row['sha256']
                        and oid.hexdigest() == row['gitBlob'], 'Часть усечена или повреждена')
                total += count
                completed.append({'index': row['index'], 'bytes': count,
                                  'sha256': digest.hexdigest(), 'gitBlob': oid.hexdigest()})
            require(total == ORIGINAL_BYTES and whole.hexdigest() == ORIGINAL_SHA256
                    and git.hexdigest() == ORIGINAL_GIT, 'Итог не равен исходному архиву')
            sink.flush()
            os.fsync(sink.fileno())
        # link создаёт имя атомарно и отказывает при конкурентном существующем пути.
        os.link(temporary, output, follow_symlinks=False)
        return {'output': str(output), 'bytes': total, 'sha256': whole.hexdigest(),
                'gitBlob': git.hexdigest(), 'parts': completed, 'gzipDecoded': False,
                'decodedIdentityBasis': 'Перенос прежней квитанции по точным сжатым байтам',
                'actualRegisteredTimingSamples': 0}
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


@contextlib.contextmanager
def command_stream(command):
    with tempfile.TemporaryFile() as errors:
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors)
        try:
            yield child.stdout
            code = child.wait()
            if code:
                errors.seek(0)
                raise RuntimeError('Источник части отказал: ' + errors.read(4096).decode(errors='replace'))
        finally:
            if child.poll() is None:
                child.kill()
            child.stdout.close()
            child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--out', required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--git-dir')
    source.add_argument('--github', action='store_true')
    args = parser.parse_args()
    require(re.fullmatch('[0-9a-f]{64}', args.manifest_sha256) is not None,
            'Нужен внешний закреплённый SHA256 карты')
    path = Path(args.manifest)
    require(path.stat().st_size <= 1024 * 1024, 'Карта частей превышает предел')
    body = path.read_bytes()
    require(hashlib.sha256(body).hexdigest() == args.manifest_sha256, 'Подменён файл карты')
    recipe = json.loads(body)

    def open_part(row):
        if args.github:
            return command_stream(['gh', 'api', 'repos/Labpics-Team/lab-motion/git/blobs/'
                                   + row['gitBlob'], '-H', 'Accept: application/vnd.github.raw+json'])
        return command_stream(['git', '--git-dir=' + args.git_dir, 'cat-file', 'blob', row['gitBlob']])

    print(json.dumps(hydrate(recipe, open_part, args.out), ensure_ascii=False))


if __name__ == '__main__':
    main()
