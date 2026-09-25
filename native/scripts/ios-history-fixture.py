"""Seed/restore synthetic history for XCUITest, only inside an iOS simulator.

Stop the app first. Pass its simctl data-container path and an unused backup file
under work/. Never run this against a physical device or production app data.
"""
import argparse
import json
from pathlib import Path
import shutil
import struct
import subprocess
import wave

parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['seed', 'verify', 'restore'])
parser.add_argument('container', type=Path)
parser.add_argument('backup', type=Path)
args = parser.parse_args()
container = args.container.resolve(strict=True)
assert '/CoreSimulator/Devices/' in str(container)
assert '/Containers/Data/Application/' in str(container)
manifest = container / 'Library/Application Support/com.kylefu.livevoice/RCTAsyncLocalStorage_V1/manifest.json'
audio = container / 'Library/Application Support/LiveVoiceRecordings'
history_key = '@live-voice-app/history/v1'
titles_key = '@live-voice-app/history-titles/v1'
ids = ['ui-history-text', 'ui-history-audio', 'ui-history-delete']

if args.mode == 'seed':
    assert not args.backup.exists(), 'Use a new backup path or restore the previous fixture.'
    data = json.loads(manifest.read_text())
    # Refuse file-backed large histories: this fixture is for an otherwise empty test app.
    assert isinstance(data.get(history_key, '[]'), str)
    history = json.loads(data.get(history_key, '[]'))
    assert not any(row['id'] in ids for row in history)
    assert len(history) <= 10, 'Use a dedicated simulator with a small synthetic history.'
    audio.mkdir(parents=True, exist_ok=True)
    for identifier in ids:
        assert not (audio / (identifier + '.json')).exists()
        assert not (audio / (identifier + '.m4a')).exists()
    args.backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(manifest, args.backup)
    for offset, identifier in enumerate(ids):
        started = 1_800_000_000_000 + offset * 1000
        history.append(dict(id=identifier, title=identifier, titleSource='manual',
                            mode='general', startedAt=started, durationSeconds=1,
                            confirmedClose=True, fragments=[dict(role='user',
                            text='Synthetic UI test conversation.', startMs=0, endMs=1000)]))
        if identifier.endswith('text'):
            continue
        wav = audio / (identifier + '.wav')
        with wave.open(str(wav), 'wb') as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(24000)
            stream.writeframes(struct.pack('<h', 0) * 24000)
        target = audio / (identifier + '.m4a')
        subprocess.run(['afconvert', '-f', 'm4af', '-d', 'aac', str(wav), str(target)], check=True)
        wav.unlink()
        (audio / (identifier + '.json')).write_text(json.dumps(dict(
            id=identifier, mode='general', startedAt=started, durationMs=1000,
            sizeBytes=target.stat().st_size, confirmedClose=True)))
    data[history_key] = json.dumps(history)
    manifest.write_text(json.dumps(data))
    print('Synthetic history fixtures seeded.')
elif args.mode == 'verify':
    data = json.loads(manifest.read_text())
    history = {row['id']: row for row in json.loads(data[history_key])}
    assert 'ui-history-text' in history
    assert 'ui-history-audio' in history
    assert 'ui-history-delete' not in history
    for identifier in ids[1:]:
        assert not (audio / (identifier + '.json')).exists()
        assert not (audio / (identifier + '.m4a')).exists()
    titles = json.loads(data.get(titles_key, '{}'))
    assert history['ui-history-text'].get('title') == 'UI renamed' or 'UI renamed' in json.dumps(titles)
    print('Verified: rename saved; audio-only deletion kept text; full deletion removed both.')
else:
    assert args.backup.is_file()
    shutil.copy2(args.backup, manifest)
    for identifier in ids:
        for extension in ['json', 'm4a', 'wav']:
            (audio / (identifier + '.' + extension)).unlink(missing_ok=True)
    print('Simulator history restored from backup.')
