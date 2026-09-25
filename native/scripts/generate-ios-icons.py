"""Create the iOS icon catalog from the already approved logo (Pillow)."""
import json
from pathlib import Path
from PIL import Image

project = Path(__file__).resolve().parents[2]
target = project / 'native/ios/LiveVoiceApp/Images.xcassets/AppIcon.appiconset'
image = Image.open(project / 'design/logo-v1-icon.png').convert('RGB')
entries = []
for idiom, sizes in [
    ('iphone', [('20x20', 2), ('20x20', 3), ('29x29', 2), ('29x29', 3), ('40x40', 2), ('40x40', 3), ('60x60', 2), ('60x60', 3)]),
    ('ipad', [('20x20', 1), ('20x20', 2), ('29x29', 1), ('29x29', 2), ('40x40', 1), ('40x40', 2), ('76x76', 1), ('76x76', 2), ('83.5x83.5', 2)]),
    ('ios-marketing', [('1024x1024', 1)]),
]:
    for size, scale in sizes:
        pixels = round(float(size.split('x')[0]) * scale)
        filename = f'icon-{pixels}.png'
        image.resize((pixels, pixels), Image.Resampling.LANCZOS).save(target / filename)
        entries.append({'idiom': idiom, 'size': size, 'scale': f'{scale}x', 'filename': filename})
(target / 'Contents.json').write_text(json.dumps({'images': entries, 'info': {'version': 1, 'author': 'xcode'}}, indent=2) + '\n')
print('Generated iOS icon catalog.')
