/*
 * Copyright (c) 2023-2025 Haitai FangYuan Co., Ltd.
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this list of
 *    conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list
 *    of conditions and the following disclaimer in the documentation and/or other materials
 *    provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors may be used
 *    to endorse or promote products derived from this software without specific prior written
 *    permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS;
 * OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
 * OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
 * ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import LogUtil from '../utils/LogUtil';

const TAG: string = 'LogMethodCall';

// Adapters are called at high frequency (file ops, the 3s cloud-sync poll,
// window events). Serializing every argument in full and writing two hilog
// lines per call costs real CPU/log I/O, and full serialization also leaks
// clipboard/notification content into the log (see CHANGES 4.2-R7).
// Cap the dump and make serialization exception-safe: JSON.stringify throws
// on cyclic structures, and an uncaught throw here would silently replace
// the wrapped method call itself.
const MAX_LOG_VALUE_LENGTH: number = 256;

const safeStringify = (value: object): string => {
  try {
    const s: string = JSON.stringify(value);
    if (s === undefined) {
      return 'undefined';
    }
    if (s.length > MAX_LOG_VALUE_LENGTH) {
      return s.substring(0, MAX_LOG_VALUE_LENGTH) + `...(len=${s.length},truncated)`;
    }
    return s;
  } catch (err) {
    return '[unserializable]';
  }
};

const isPromiseLike = (value: Object | undefined): boolean => {
  return !!value && typeof (value as Record<string, Object>)['then'] === 'function';
};

// Shared wrapper behind LogMethod and LogAll. Async adapter methods used to
// log "out => {}" because a Promise serializes to an empty object; the
// wrapper now logs the settled value (or the rejection) from a side-chain,
// leaving the original promise untouched for the caller.
const wrapLogged = (className: string, methodName: string,
  method: (...args: object[]) => object,
  propertyDescriptor: PropertyDescriptor): void => {
  propertyDescriptor.value = function (...args: object[]) {
    const params = args.map((a: object) => safeStringify(a)).join();
    LogUtil.info(TAG, `${className}#${methodName}(${params}) in `);

    const result = method.apply(this, args);
    if (isPromiseLike(result)) {
      const promise = result as Promise<Object>;
      promise.then((settled: Object) => {
        LogUtil.info(TAG, `${className}#${methodName}(${params}) out(promise) => ${safeStringify(settled)}`);
      }).catch((err: Object) => {
        LogUtil.error(TAG, `${className}#${methodName}(${params}) rejected => ${safeStringify(err)}`);
      });
      return result;
    }
    LogUtil.info(TAG, `${className}#${methodName}(${params}) out => ${safeStringify(result)}`);
    return result;
  };
};

/**
 * Method log decorator
 */
const LogMethod = (
  target: Object,
  methodName: string,
  propertyDescriptor: PropertyDescriptor): PropertyDescriptor => {
  wrapLogged(target.constructor.name, methodName, propertyDescriptor.value, propertyDescriptor);
  return propertyDescriptor;
};

/**
 * Class decorator to log all methods
 */
export const LogAll = (target: ObjectConstructor) => {
  Reflect.ownKeys(target.prototype).forEach(propertyKey => {
    let propertyDescriptor: PropertyDescriptor = Object.getOwnPropertyDescriptor(target.prototype, propertyKey);
    if (propertyDescriptor && propertyDescriptor.value) {
      wrapLogged(target.name, propertyKey.toString(), propertyDescriptor.value, propertyDescriptor);
      Object.defineProperty(target.prototype, propertyKey, propertyDescriptor);
    }
  });
};

export default LogMethod;
