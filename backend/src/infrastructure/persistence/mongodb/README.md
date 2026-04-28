# MongoDB models — legacy, pending removal

**Estado**: pendiente de eliminar tras ejecutar la migración de datos.

Estos modelos Mongoose se conservan **exclusivamente** para que el script
`backend/src/scripts/migrate_mongo_to_pg.js` pueda leer los datos existentes
en MongoDB Atlas y copiarlos a PostgreSQL.

## Qué hacer cuando la migración esté finalizada

Una vez que `migrate_mongo_to_pg.js` se haya ejecutado con éxito en producción y
se haya verificado que todos los datos están en Postgres:

```bash
# 1. Borra esta carpeta entera
rm -rf backend/src/infrastructure/persistence/mongodb/

# 2. Borra el script de migración y los dos que aún dependen de mongoose
rm backend/src/scripts/migrate_mongo_to_pg.js
rm backend/src/scripts/migrate_respuestas_correctas.js

# 3. Desinstala los paquetes Mongo
cd backend
npm uninstall mongoose mongodb mongoos
```

Después de esto el repositorio no tendrá ninguna referencia a MongoDB.

## Por qué no eliminarlo ahora mismo

Porque eliminarlo rompería el script de migración que todavía necesitas ejecutar
al menos una vez en cada entorno (local + producción) para traer los datos de
Mongo Atlas. Tras ese `node src/scripts/migrate_mongo_to_pg.js` exitoso, estos
archivos son código muerto y deben desaparecer.
