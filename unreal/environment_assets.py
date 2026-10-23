"""Shared, cooked daylight environment for physically exposed live and baked scenes."""
import unreal

def create_environment_assets():
    cube_path = '/Game/Archai/DaylightAmbientCubemap'
    if not unreal.EditorAssetLibrary.does_asset_exist(cube_path):
        original = unreal.load_asset('/Engine/MapTemplates/Sky/DaylightAmbientCubemap.DaylightAmbientCubemap')
        if not original or not unreal.AssetToolsHelpers.get_asset_tools().duplicate_asset('DaylightAmbientCubemap','/Game/Archai',original):
            raise RuntimeError('Could not prepare the daylight environment')
    cube = unreal.load_asset(cube_path)
    name = '/Game/Archai/M_EnvironmentSky'
    mat = unreal.load_asset(name) or unreal.AssetToolsHelpers.get_asset_tools().create_asset('M_EnvironmentSky','/Game/Archai',unreal.Material,unreal.MaterialFactoryNew())
    lib = unreal.MaterialEditingLibrary
    lib.delete_all_material_expressions(mat)
    mat.set_editor_property('two_sided',True)
    mat.set_editor_property('shading_model',unreal.MaterialShadingModel.MSM_UNLIT)
    def n(cls): return lib.create_material_expression(mat,cls,0,0)
    def color(name,value):
        node = n(unreal.MaterialExpressionVectorParameter); node.set_editor_property('parameter_name',name); node.set_editor_property('default_value',unreal.LinearColor(*value)); return node
    horizon = color('Horizon',(0.64,0.86,1.1,1)); zenith = color('Zenith',(0.2,0.4,0.84,1))
    direction = n(unreal.MaterialExpressionCameraVectorWS)
    mask = n(unreal.MaterialExpressionComponentMask); mask.set_editor_property('r',False); mask.set_editor_property('g',False); mask.set_editor_property('b',True); mask.set_editor_property('a',False)
    lib.connect_material_expressions(direction,'',mask,'')
    absolute = n(unreal.MaterialExpressionAbs); lib.connect_material_expressions(mask,'',absolute,'')
    gradient = n(unreal.MaterialExpressionLinearInterpolate)
    for source,pin in [(horizon,'A'),(zenith,'B'),(absolute,'Alpha')]: lib.connect_material_expressions(source,'',gradient,pin)
    scale = n(unreal.MaterialExpressionScalarParameter); scale.set_editor_property('parameter_name','SkyScale'); scale.set_editor_property('default_value',5000)
    result = n(unreal.MaterialExpressionMultiply); lib.connect_material_expressions(gradient,'',result,'A'); lib.connect_material_expressions(scale,'',result,'B')
    lib.connect_material_property(result,'',unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    lib.recompile_material(mat)
    unreal.EditorAssetLibrary.save_loaded_asset(mat)
    unreal.EditorAssetLibrary.save_loaded_asset(cube)
    return cube
