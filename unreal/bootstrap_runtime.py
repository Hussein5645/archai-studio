"""Create the empty cooked entry map; all user geometry is imported by the runtime."""
import unreal
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from environment_assets import create_environment_assets
create_environment_assets()

# Cook these shader variants once. Live scenes only set parameters; they never compile shaders.
lib = unreal.MaterialEditingLibrary
assets = unreal.AssetToolsHelpers.get_asset_tools()

def master(name, transparent=False):
    path = '/Game/Archai/' + name
    mat = unreal.load_asset(path) or assets.create_asset(name, '/Game/Archai', unreal.Material, unreal.MaterialFactoryNew())
    lib.delete_all_material_expressions(mat)
    mat.set_editor_property('two_sided', True)
    mat.set_editor_property('blend_mode', unreal.BlendMode.BLEND_TRANSLUCENT if transparent else unreal.BlendMode.BLEND_MASKED)
    mat.set_editor_property('opacity_mask_clip_value', 0.333)
    if transparent:
        mat.set_editor_property('translucency_lighting_mode', unreal.TranslucencyLightingMode.TLM_SURFACE_PER_PIXEL_LIGHTING)
    def node(cls): return lib.create_material_expression(mat, cls, 0, 0)
    def link(a, b, pin, output=''):
        if not lib.connect_material_expressions(a, output, b, pin):
            raise RuntimeError('Could not connect material pin: ' + pin)
    def scalar(name, value):
        n = node(unreal.MaterialExpressionScalarParameter); n.set_editor_property('parameter_name', name); n.set_editor_property('default_value', value); return n
    def vector(name, values):
        n = node(unreal.MaterialExpressionVectorParameter); n.set_editor_property('parameter_name', name); n.set_editor_property('default_value', unreal.LinearColor(*values)); return n
    def multiply(a, b):
        n = node(unreal.MaterialExpressionMultiply); link(a, n, 'A'); link(b, n, 'B'); return n
    def lerp(a, b, alpha):
        n = node(unreal.MaterialExpressionLinearInterpolate); link(a,n,'A'); link(b,n,'B'); link(alpha,n,'Alpha'); return n
    def component(a, channel):
        if channel == 'a':
            n = node(unreal.MaterialExpressionMultiply); link(a,n,'A','A'); link(scalar('AlphaOne',1),n,'B'); return n
        n = node(unreal.MaterialExpressionComponentMask)
        for c in 'rgba': n.set_editor_property(c, c == channel)
        link(a,n,''); return n
    def texture(name):
        uv = node(unreal.MaterialExpressionTextureCoordinate)
        append = node(unreal.MaterialExpressionAppendVector); link(uv, append, 'A'); link(scalar('UVOne',1),append,'B')
        coords = []
        for axis, default in [('U',(1,0,0,0)),('V',(0,1,0,0))]:
            dot = node(unreal.MaterialExpressionDotProduct); link(append,dot,'A'); link(vector(name+'_'+axis,default),dot,'B'); coords.append(dot)
        coord = node(unreal.MaterialExpressionAppendVector); link(coords[0],coord,'A'); link(coords[1],coord,'B')
        sample = node(unreal.MaterialExpressionTextureSampleParameter2D); sample.set_editor_property('parameter_name',name)
        sample.set_editor_property('texture',unreal.load_asset('/Engine/EngineResources/WhiteSquareTexture.WhiteSquareTexture'))
        link(coord,sample,'')
        return sample, scalar('Has_'+name,0)
    one = scalar('One',1)
    base, has_base = texture('map'); normal, has_normal = texture('normalMap')
    rough, has_rough = texture('roughnessMap'); metal, has_metal = texture('metalnessMap'); emission, has_emission = texture('emissiveMap')
    ao, has_ao = texture('aoMap'); alpha, has_alpha = texture('alphaMap')
    white = vector('White',(1,1,1,1))
    base_color = multiply(vector('BaseColor',(1,1,1,1)),lerp(white,base,has_base))
    vertex = node(unreal.MaterialExpressionVertexColor)
    base_color = multiply(base_color,lerp(white,vertex,scalar('VertexColors',0)))
    lib.connect_material_property(base_color,'',unreal.MaterialProperty.MP_BASE_COLOR)
    lib.connect_material_property(multiply(scalar('Roughness',1),lerp(one,component(rough,'g'),has_rough)),'',unreal.MaterialProperty.MP_ROUGHNESS)
    lib.connect_material_property(multiply(scalar('Metalness',0),lerp(one,component(metal,'b'),has_metal)),'',unreal.MaterialProperty.MP_METALLIC)
    decoded = node(unreal.MaterialExpressionSubtract); link(multiply(normal,scalar('Two',2)),decoded,'A'); link(one,decoded,'B')
    lib.connect_material_property(lerp(vector('FlatNormal',(0,0,1,0)),multiply(decoded,vector('NormalScale',(1,1,1,0))),has_normal),'',unreal.MaterialProperty.MP_NORMAL)
    lib.connect_material_property(lerp(one,lerp(one,component(ao,'r'),scalar('AOIntensity',1)),has_ao),'',unreal.MaterialProperty.MP_AMBIENT_OCCLUSION)
    emit = multiply(vector('Emissive',(0,0,0,1)),lerp(white,emission,has_emission))
    total_emit = node(unreal.MaterialExpressionAdd); link(emit,total_emit,'A'); link(multiply(base_color,scalar('Unlit',0)),total_emit,'B')
    lib.connect_material_property(total_emit,'',unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    opacity = multiply(multiply(scalar('Opacity',1),lerp(one,component(base,'a'),has_base)),lerp(one,component(alpha,'g'),has_alpha))
    if transparent:
        lib.connect_material_property(opacity,'',unreal.MaterialProperty.MP_OPACITY)
    else:
        threshold = node(unreal.MaterialExpressionSubtract); link(opacity,threshold,'A'); link(scalar('AlphaTest',0),threshold,'B')
        mask = node(unreal.MaterialExpressionAdd); link(threshold,mask,'A'); link(scalar('MaskClip',0.333),mask,'B')
        lib.connect_material_property(mask,'',unreal.MaterialProperty.MP_OPACITY_MASK)
    lib.recompile_material(mat); unreal.EditorAssetLibrary.save_loaded_asset(mat)

master('M_LiveOpaque')
master('M_LiveTransparent', True)

levels = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
exists = unreal.EditorAssetLibrary.does_asset_exist('/Game/Archai/Viewer')
if not (levels.load_level('/Game/Archai/Viewer') if exists else levels.new_level('/Game/Archai/Viewer')):
    raise RuntimeError('Could not create runtime entry level')
world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
world.get_world_settings().set_editor_property('default_game_mode', unreal.ArchaiRenderGameMode)
if not levels.save_current_level():
    raise RuntimeError('Could not save runtime entry level')
