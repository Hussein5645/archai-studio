using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace Archai.Revit;

/// <summary>The visible source model in the active 3D view, including temporary hide/isolate.</summary>
internal static class LiveViewScope
{
    public static View3D? Active(UIApplication ui, Document doc) =>
        ui.ActiveUIDocument?.Document.Equals(doc) == true && ui.ActiveUIDocument.ActiveView is View3D { IsTemplate: false } view ? view : null;

    public static HashSet<long> VisibleIds(Document doc, View3D view)
    {
        if (!FilteredElementCollector.IsViewValidForElementIteration(doc, view.Id))
            throw new System.InvalidOperationException("This 3D view cannot supply visible model geometry.");
        var temporary = view.IsTemporaryHideIsolateActive();
        return new HashSet<long>(new FilteredElementCollector(doc, view.Id)
            .WhereElementIsNotElementType().WhereElementIsViewIndependent()
            .Where(element => element.Category?.CategoryType == CategoryType.Model && !Live.IsLive(element))
            .Where(element => !element.IsHidden(view) && (!view.CanCategoryBeHidden(element.Category.Id) || !view.GetCategoryHidden(element.Category.Id)))
            .Where(element => !temporary || view.IsElementVisibleInTemporaryViewMode(TemporaryViewMode.TemporaryHideIsolate, element.Id))
            .Select(element => element.Id.Value));
    }
}
