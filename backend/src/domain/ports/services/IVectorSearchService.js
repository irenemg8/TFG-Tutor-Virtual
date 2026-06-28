"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                IVECTORSEARCHSERVICE                   |
            |  Port/interface defining the contract for vector      |
            |  similarity search. The active adapter is             |
            |  ChromaVectorSearchService; the methods here throw.   |
            |                                                       |
        ____|________________________                              |
   [R], Txt, Z -> | search() | -> Promise<[Obj]>                  |
                  -----------                                      |
        ____|__________________                                    |
   Txt, [Obj] -> | addDocuments() | -> Promise<void>              |
                 ----------------                                  |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class IVectorSearchService {
  /*
   [R], Txt, Z -> ____|__________
                 | search() | -> Promise<[Obj]>
                  -----------
      Contract: search a collection for documents similar to the query
      embedding, returning up to topK matches as
      { id, content, score, metadata }. Abstract here.
  */
  async search(queryEmbedding, collectionName, topK) {
    throw new Error("Not implemented");
  }

  /*
   Txt, [Obj] -> ____|________________
                | addDocuments() | -> Promise<void>
                 ----------------
      Contract: add documents (each { id, content, embedding, metadata })
      to the named collection. Abstract here.
  */
  async addDocuments(collectionName, data) {
    throw new Error("Not implemented");
  }
}

module.exports = IVectorSearchService;
