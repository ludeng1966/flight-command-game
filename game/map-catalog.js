// 地图清单：把场景里的 map 名称解析到实际地形资源，避免在 main 里硬编码文件名。
export const MAP_CATALOG_SCHEMA = 'flight-command-map-catalog/1';

export function resolveMap(catalog, mapId, {allowMissing = false} = {}) {
  const maps = catalog?.maps;
  if (!maps || typeof maps !== 'object') {
    if (allowMissing) return null;
    throw Error('地图清单缺少 maps');
  }
  const id = mapId ?? catalog.default;
  const map = id && maps[id];
  if (!map) {
    if (allowMissing) return null;
    throw Error(`地图清单中没有 ${id ?? '(未指定)'}`);
  }
  for (const key of ['heightPrefix', 'contours', 'landmask']) {
    if (typeof map[key] !== 'string' || !map[key]) {
      if (allowMissing) return null;
      throw Error(`地图 ${id} 缺少 ${key}`);
    }
  }
  return {id, ...map};
}

export function mapAssetUrls(map, base = '../terrain/') {
  return {
    contours: base + map.contours,
    landmask: base + map.landmask,
    heightPrefix: base + map.heightPrefix
  };
}
