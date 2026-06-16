"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  IEJERCICIOREPOSITORY                 |
            |  Port/interface defining the persistence contract for |
            |  Ejercicio entities. Adapters (Mongo, Postgres)       |
            |  implement it; the methods here just throw.           |
            |                                                       |
        ____|________________________                              |
   Txt -> | findById() | -> Promise<Ejercicio>                     |
        --------------                                              |
        ____|___________                                           |
        | findAll() | -> Promise<[Ejercicio]>                      |
        ------------                                                |
        ____|__________                                            |
   Obj -> | create() | -> Promise<Ejercicio>                       |
          -----------                                              |
        ____|________________                                      |
   Txt, Obj -> | updateById() | -> Promise<Ejercicio>             |
              ----------------                                     |
        ____|________________                                      |
   Txt -> | deleteById() | -> Promise<void>                        |
          ----------------                                         |
        ____|_________________________                             |
   Txt -> | findOneByConcept() | -> Promise<Ejercicio | null>      |
          ----------------------                                   |
        ____|________________                                      |
   [Txt] -> | findByIds() | -> Promise<[Ejercicio]>               |
            -------------                                          |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class IEjercicioRepository {
  /*
   Txt -> ____|____________
         | findById() | -> Promise<Ejercicio>
          -------------
      Contract: resolve the exercise with the given id. Abstract here.
  */
  async findById(id) {
    throw new Error("Not implemented");
  }

  /*
       ____|___________
      | findAll() | -> Promise<[Ejercicio]>
       ------------
      Contract: resolve the full list of exercises. Abstract here.
  */
  async findAll() {
    throw new Error("Not implemented");
  }

  /*
   Obj -> ____|__________
         | create() | -> Promise<Ejercicio>
          -----------
      Contract: persist a new exercise and resolve it. Abstract here.
  */
  async create(data) {
    throw new Error("Not implemented");
  }

  /*
   Txt, Obj -> ____|________________
              | updateById() | -> Promise<Ejercicio>
               ----------------
      Contract: update the exercise by id and resolve it. Abstract here.
  */
  async updateById(id, fields) {
    throw new Error("Not implemented");
  }

  /*
   Txt -> ____|________________
         | deleteById() | -> Promise<void>
          ----------------
      Contract: remove the exercise with the given id. Abstract here.
  */
  async deleteById(id) {
    throw new Error("Not implemented");
  }

  /*
   Txt -> ____|_________________________
         | findOneByConcept() | -> Promise<Ejercicio | null>
          ----------------------
      Contract: resolve one exercise matching a concept (used for
      recommendations), or null. Abstract here.
  */
  async findOneByConcept(concept) {
    throw new Error("Not implemented");
  }

  /*
   [Txt] -> ____|____________
           | findByIds() | -> Promise<[Ejercicio]>
            -------------
      Contract: resolve all exercises for the given id list. Abstract here.
  */
  async findByIds(ids) {
    throw new Error("Not implemented");
  }
}

module.exports = IEjercicioRepository;
