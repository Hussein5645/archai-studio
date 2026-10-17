import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Locale = 'en' | 'ar';

const AR: Record<string, string> = {
  'Opening 3D view': 'جارٍ فتح العرض ثلاثي الأبعاد', 'Preparing 3D view': 'جارٍ تجهيز العرض ثلاثي الأبعاد',
  'Loading 3D resources': 'جارٍ تحميل موارد العرض ثلاثي الأبعاد', 'Building 3D scene': 'جارٍ بناء المشهد ثلاثي الأبعاد',
  'Preparing 3D display': 'جارٍ تجهيز العرض', 'Preparing first frame': 'جارٍ تجهيز الإطار الأول',
  'Camera pinned': 'الكاميرا مثبتة', 'Loading 3D view…': 'جارٍ تحميل العرض ثلاثي الأبعاد…',
  Saving: 'الحفظ', 'Autosave local projects': 'حفظ المشاريع المحلية تلقائياً',
  'Online projects always autosave and sync. With local autosave off, click Unsaved changes to save.': 'تُحفظ المشاريع المتصلة وتُزامن دائماً تلقائياً. عند إيقاف الحفظ المحلي التلقائي، انقر على التغييرات غير المحفوظة للحفظ.',
  'Saving…': 'جارٍ الحفظ…', 'Save project': 'حفظ المشروع', 'Save failed — retry': 'فشل الحفظ — أعد المحاولة',
  'Opening project': 'جارٍ فتح المشروع', 'Loading progress': 'تقدم التحميل',
  'Reading project': 'جارٍ قراءة المشروع', 'Checking project': 'جارٍ التحقق من المشروع',
  'Preparing drawing': 'جارٍ تجهيز الرسم', 'Preparing selection': 'جارٍ تجهيز التحديد',
  'Preparing assets': 'جارٍ تجهيز الأصول', 'Preparing 3D views': 'جارٍ تجهيز العروض ثلاثية الأبعاد',
  'Opening workspace': 'جارٍ فتح مساحة العمل', Ready: 'جاهز',
  Settings: 'الإعدادات', Interface: 'الواجهة', 'UI scale': 'حجم الواجهة', 'ArchAI menu': 'قائمة ArchAI',
  'Size of bars, panels, menus and dialogs. The drawing keeps its own zoom.': 'حجم الأشرطة واللوحات والقوائم والنوافذ. يحتفظ الرسم بتكبيره الخاص.',
  'Auto: using touch now': 'تلقائي: اللمس مستخدم الآن', 'Auto: using mouse now': 'تلقائي: الفأرة مستخدمة الآن', 'Larger controls and touch gestures': 'أزرار أكبر وإيماءات اللمس',
  'Board navigation': 'التنقل في اللوحة', 'Mouse wheel': 'عجلة الفأرة', Pan: 'تحريك', Zoom: 'تكبير',
  'Ctrl + wheel and trackpad pinch always zoom; with Zoom, Shift + wheel pans.': 'Ctrl مع العجلة وقرص لوحة اللمس يكبّران دائماً؛ مع خيار التكبير، Shift مع العجلة يحرّك.',
  Pen: 'القلم', 'Palm rejection': 'تجاهل راحة اليد', 'After the pen touches the screen, fingers only pan and zoom for a few seconds.': 'بعد لمس القلم للشاشة، تقتصر الأصابع على التحريك والتكبير لبضع ثوانٍ.',
  'Reset to defaults': 'استعادة الافتراضي',
  Annotate: 'تعليقات توضيحية', 'Annotation tools': 'أدوات التعليق', 'Sketch pen': 'قلم الرسم', Highlighter: 'قلم التظليل', Eraser: 'ممحاة', 'Sticky note': 'ملاحظة لاصقة',
  'New annotation layer': 'طبقة تعليقات جديدة', 'Annotation layer': 'طبقة التعليقات', 'New layer on first stroke': 'طبقة جديدة عند أول رسم', Pressure: 'الضغط',
  'Pen colour': 'لون القلم', 'Highlighter colour': 'لون التظليل', 'Note colour': 'لون الملاحظة', hidden: 'مخفية', locked: 'مقفلة',
  'Stroke width follows the pen pressure': 'سمك الخط يتبع ضغط القلم', 'Annotation layers show on the board only: never on sheets, exports or 3D views': 'طبقات التعليقات تظهر على اللوحة فقط: لا تظهر في الأوراق أو التصدير أو العروض ثلاثية الأبعاد',
  Modify: 'تعديل', Analyze: 'تحليل', Diagram: 'مخطط', 'Type a note': 'اكتب ملاحظة',
  'Window too narrow': 'النافذة ضيقة جداً',
  'Drag the window wider to keep working.': 'وسّع النافذة للمتابعة في العمل.',
  Language: 'اللغة', English: 'الإنجليزية', Arabic: 'العربية',
  'Touch Screen Mode': 'وضع الشاشة اللمسية', 'Touch mode': 'وضع اللمس', Auto: 'تلقائي', On: 'تشغيل', Off: 'إيقاف',
  Enabled: 'مفعّل', Disabled: 'معطّل',
  Commands: 'الأوامر', Undo: 'تراجع', Redo: 'إعادة', New: 'جديد', Open: 'فتح', Save: 'حفظ',
  Saved: 'تم الحفظ', 'Unsaved changes': 'تغييرات غير محفوظة', 'Autosaved locally': 'محفوظ تلقائياً على الجهاز',
  'Document name': 'اسم المستند', 'Toggle layers & assets panel': 'إظهار أو إخفاء لوحة الطبقات والأصول', 'Toggle inspector': 'إظهار أو إخفاء الخصائص',
  Layers: 'الطبقات', Assets: 'الأصول', Inspector: 'الخصائص', Workspace: 'مساحة العمل',
  Select: 'تحديد', Hand: 'تحريك', Rectangle: 'مستطيل', Line: 'خط', Text: 'نص', Image: 'صورة', Measure: 'قياس',
  '3D view': 'عرض ثلاثي الأبعاد', 'Section view': 'مقطع', Paper: 'ورقة', Build: 'بناء', 'Asset library': 'مكتبة الأصول',
  Section: 'مقطع', Asset: 'أصل', Polyline: 'خط متعدد',
  Navigate: 'تنقّل', 'Draw and annotate': 'رسم وتعليق', 'Views and sheets': 'العروض والأوراق', Tools: 'الأدوات',
  '3D workspace': 'مساحة العمل ثلاثية الأبعاد', 'Section workspace': 'مساحة عمل المقطع',
  'View style': 'نمط العرض', Realistic: 'واقعي', Wireframe: 'هيكلي', Shaded: 'مظلّل', 'Consistent colors': 'ألوان متناسقة',
  'Frame all': 'إظهار الكل', 'Close 3D workspace': 'إغلاق مساحة العمل ثلاثية الأبعاد',
  'Drag to orbit · right-drag to pan · wheel to zoom · click to select · G move · R rotate · F frame all · Esc back to board': 'اسحب للدوران · اسحب بالزر الأيمن للتحريك · استخدم العجلة للتكبير · انقر للتحديد · G للنقل · R للدوران · F لإظهار الكل · Esc للعودة',
  'Drag to pan · wheel to zoom · F frame section · Esc back to board': 'اسحب للتحريك · استخدم العجلة للتكبير · F لإظهار المقطع · Esc للعودة',
  'Nothing on the board yet.': 'لا توجد عناصر على اللوحة بعد.', 'Empty board': 'لوحة فارغة',
  Show: 'إظهار', Hide: 'إخفاء', Pin: 'تثبيت', Unpin: 'إلغاء التثبيت', Expand: 'توسيع', Collapse: 'طي', 'Layer name': 'اسم الطبقة',
  Background: 'الخلفية', Units: 'الوحدات', Precision: 'الدقة', Grid: 'الشبكة', 'Grid size': 'حجم الشبكة', 'Snap to grid': 'المحاذاة إلى الشبكة',
  Views: 'العروض', 'Lock plan view as image': 'تثبيت المسقط كصورة', 'Add 3D view': 'إضافة عرض ثلاثي الأبعاد', 'Add paper': 'إضافة ورقة',
  Position: 'الموقع', Size: 'الحجم', Rotation: 'الدوران', Appearance: 'المظهر', Fill: 'التعبئة', Stroke: 'الحد', Opacity: 'الشفافية',
  Width: 'العرض', Height: 'الارتفاع', Name: 'الاسم', Title: 'العنوان', Orientation: 'الاتجاه', Landscape: 'أفقي', Portrait: 'عمودي', Custom: 'مخصص',
  'Export PDF': 'تصدير PDF', 'Scale 1:': 'المقياس 1:', Configuration: 'الإعدادات', Configure: 'تهيئة',
  'Open section full screen': 'فتح المقطع بملء الشاشة', 'Open 3D workspace': 'فتح مساحة العمل ثلاثية الأبعاد', 'Flip direction': 'عكس الاتجاه',
  'Edit board': 'تحرير اللوحة', 'Hide board editor': 'إخفاء محرر اللوحة',
  'Lock view as image': 'تثبيت العرض كصورة', 'Flip section direction': 'عكس اتجاه المقطع', 'Open full screen': 'فتح بملء الشاشة',
  touch: 'لمس', mouse: 'فأرة',
  'New file': 'ملف جديد', 'Open file': 'فتح ملف', 'e.g. Ground floor plan': 'مثال: مسقط الطابق الأرضي', Untitled: 'بلا عنوان',
  'Save a copy of the current file first?': 'هل تريد حفظ نسخة من الملف الحالي أولاً؟',
  'has work that is not saved to a .AIR file. It will be replaced by the new file.': 'يحتوي على عمل غير محفوظ في ملف ‎.AIR وسيُستبدل بالملف الجديد.',
  'has work that is not saved to a .AIR file. It will be replaced by the opened file.': 'يحتوي على عمل غير محفوظ في ملف ‎.AIR وسيُستبدل بالملف المفتوح.',
  "Don't save": 'عدم الحفظ', 'Save copy & create': 'حفظ نسخة ثم إنشاء', 'Save copy & open': 'حفظ نسخة ثم فتح',
  'Element graphics': 'رسوميات العناصر', 'Display settings': 'إعدادات العرض', Display: 'العرض', Preset: 'إعداد مسبق', 'My presets': 'إعداداتي',
  'Save as preset': 'حفظ كإعداد مسبق', 'Delete preset': 'حذف الإعداد المسبق', 'Import presets from a file': 'استيراد إعدادات من ملف', 'Export as a shareable file': 'تصدير كملف قابل للمشاركة',
  'Preset name': 'اسم الإعداد المسبق', Board: 'اللوحة', '3D': 'ثلاثي الأبعاد', 'All styles': 'كل الأنماط', 'Hidden line': 'خط مخفي', current: 'الحالي', 'Reset all': 'إعادة تعيين الكل', Reset: 'إعادة تعيين', Done: 'تم',
  Fills: 'التعبئات', Lines: 'الخطوط', Symbol: 'الرمز', Materials: 'المواد', 'Cut surface': 'سطح القطع', 'Cut outline': 'حد القطع', 'Beyond the cut': 'خلف القطع', Scene: 'المشهد', 'New elements': 'العناصر الجديدة',
  Structure: 'الإنشاء', Openings: 'الفتحات', Circulation: 'الحركة', Envelope: 'الغلاف', Spaces: 'الفراغات', Drawing: 'الرسم', Annotation: 'التعليقات', 'Element types': 'أنواع العناصر',
  Colour: 'اللون', None: 'بلا', Close: 'إغلاق', Cancel: 'إلغاء', Create: 'إنشاء', Delete: 'حذف', Search: 'بحث',
  picker: 'منتقي', 'View orthographic previews and parameters': 'عرض المساقط المتعامدة والمعلمات',
  'Uniform scale': 'مقياس موحّد', 'Corner radius': 'نصف قطر الزاوية', 'Closed shape': 'شكل مغلق', 'Font size': 'حجم الخط', Align: 'المحاذاة',
  'Edit text': 'تحرير النص', Unhost: 'فك الارتباط', 'Detach from asset': 'فصل عن الأصل', Ungroup: 'فك التجميع', Group: 'تجميع', 'Make asset': 'إنشاء أصل',
  Pinned: 'مثبّت', Visible: 'مرئي', Metadata: 'البيانات الوصفية', 'Stroke width': 'سماكة الحد',
  'Drag to draw a rectangle · click for 1 × 1 m': 'اسحب لرسم مستطيل · انقر لإنشاء 1 × 1 م',
  'Click to add points · double-click or Enter to finish · Esc to cancel': 'انقر لإضافة نقاط · انقر مرتين أو اضغط Enter للإنهاء · Esc للإلغاء',
  'Click to place text': 'انقر لوضع النص', 'Click to choose an image': 'انقر لاختيار صورة',
  'Click the first point, then click the second point · Shift constrains angle': 'انقر النقطة الأولى ثم الثانية · Shift لتقييد الزاوية',
  'Drag to place a 3D view portal · click for a default size · double-click the portal to open the 3D workspace': 'اسحب لوضع نافذة عرض ثلاثية الأبعاد · انقر للحجم الافتراضي · انقر مرتين لفتح مساحة العمل',
  'Click the two ends of the cut line · move its endpoints to update the section · flip direction from the viewport': 'حدّد طرفي خط المقطع · حرّك نقاطه لتحديث المقطع · اعكس الاتجاه من نافذة العرض',
  'Click for an A4 sheet at 1:50 · drag for a custom sheet · select it and export as PDF from the Inspector': 'انقر لورقة A4 بمقياس 1:50 · اسحب لورقة مخصصة · حدّدها وصدّر PDF من الخصائص',
  'Source': 'المصدر', 'Local': 'محلي', 'Catalog': 'الكتالوج', 'Built-in': 'مدمج', 'No results': 'لا توجد نتائج',
  'Millimetres': 'ملليمتر', 'Centimetres': 'سنتيمتر', 'Metres': 'متر', 'Inches': 'بوصة', 'Feet': 'قدم',
  'Wall': 'جدار', 'Door': 'باب', 'Window': 'نافذة', 'Column': 'عمود', 'Stairs': 'درج', 'Railing': 'درابزين', 'Room': 'غرفة',
  'Linked 3D Models': 'نماذج ثلاثية الأبعاد مرتبطة',
  'No modeling files linked to this project yet': 'لا توجد ملفات نمذجة مرتبطة بهذا المشروع بعد',
  'Model New 3D Element': 'نمذجة عنصر ثلاثي أبعاد جديد',
  'New Model': 'نموذج جديد',
  'Open in 3D Modeling': 'فتح في بيئة النمذجة ثلاثية الأبعاد',
  'Delete modeling file': 'حذف ملف النمذجة',
  'Draft': 'مسودة',
  'Open in tab': 'مفتوح في علامة تبويب',
  'Download': 'تنزيل',
  'AI Portal': 'بوابة الذكاء الاصطناعي',
  'AI Tools': 'أدوات الذكاء الاصطناعي',
  'Ask AI Assistant...': 'اسأل المساعد الذكي...',
  'AI Assistant': 'المساعد الذكي',
  'Send message': 'إرسال الرسالة',
  'Clear conversation': 'مسح المحادثة',
  'AI coming soon': 'الذكاء الاصطناعي قريباً',
  'Drag to draw an AI portal · click for a default size': 'اسحب لرسم بوابة ذكاء اصطناعي · انقر للحجم الافتراضي',
  'msg': 'رسالة',
  'msgs': 'رسائل',
  'You': 'أنت',
  'Attach file': 'إرفاق ملف',
};

function translateArabic(value: string): string {
  const direct = AR[value];
  if (direct) return direct;
  const shortcut = value.match(/^(.+?) \((.+)\)$/);
  if (shortcut && AR[shortcut[1]!]) return `${AR[shortcut[1]!]} (${shortcut[2]})`;
  const count = value.match(/^(\d+) elements$/);
  if (count) return `${count[1]} عناصر`;
  return value;
}

interface I18nValue { locale: Locale; setLocale: (locale: Locale) => void; t: (value: string) => string; }
const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => localStorage.getItem('archai.locale') === 'ar' ? 'ar' : 'en');
  useEffect(() => {
    localStorage.setItem('archai.locale', locale);
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);
  const value = useMemo<I18nValue>(() => ({ locale, setLocale, t: (text) => locale === 'ar' ? translateArabic(text) : text }), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
