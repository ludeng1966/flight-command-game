import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveMap,mapAssetUrls,MAP_CATALOG_SCHEMA} from '../game/map-catalog.js';

const catalog={schema:MAP_CATALOG_SCHEMA,default:'air_skyscraper_city',maps:{
  air_skyscraper_city:{name:'海湾天空城',heightPrefix:'air_skyscraper_city',contours:'air_skyscraper_city_contours.json',landmask:'air_skyscraper_city_landmask.json'}
}};
test('地图清单：按场景 map 解析资源，未知地图报错',()=>{
  const map=resolveMap(catalog,'air_skyscraper_city');
  assert.equal(map.id,'air_skyscraper_city');
  assert.deepEqual(mapAssetUrls(map),{
    contours:'../terrain/air_skyscraper_city_contours.json',
    landmask:'../terrain/air_skyscraper_city_landmask.json',
    heightPrefix:'../terrain/air_skyscraper_city'
  });
  assert.throws(()=>resolveMap(catalog,'missing'),/地图清单中没有 missing/);
  assert.equal(resolveMap(catalog,undefined).id,'air_skyscraper_city');
});
test('地图清单：缺字段直接报错，不静默加载错误文件',()=>{
  assert.throws(()=>resolveMap({maps:{bad:{heightPrefix:'x'}}},'bad'),/缺少 contours/);
  assert.throws(()=>resolveMap(null,'x'),/缺少 maps/);
});
