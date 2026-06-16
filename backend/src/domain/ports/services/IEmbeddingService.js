"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  IEMBEDDINGSERVICE                    |
            |  Port/interface defining the contract for text        |
            |  embedding generation. The active adapter is          |
            |  OllamaEmbeddingService; the methods here just throw. |
            |                                                       |
        ____|________________________                              |
   Txt -> | generateEmbedding() | -> Promise<[R]>                  |
          ----------------------                                   |
        ____|__________________________                            |
   [Txt] -> | generateEmbeddings() | -> Promise<[[R]]>            |
            -----------------------                                |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class IEmbeddingService {
  /*
   Txt -> ____|________________________
         | generateEmbedding() | -> Promise<[R]>
          ----------------------
      Contract: resolve the embedding vector for a single text.
      Abstract here.
  */
  async generateEmbedding(text) {
    throw new Error("Not implemented");
  }

  /*
   [Txt] -> ____|__________________________
           | generateEmbeddings() | -> Promise<[[R]]>
            -----------------------
      Contract: resolve one embedding vector per input text. Abstract
      here.
  */
  async generateEmbeddings(texts) {
    throw new Error("Not implemented");
  }
}

module.exports = IEmbeddingService;
