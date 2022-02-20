/* eslint-disable  */
import { Injectable } from '@nestjs/common';
import { FindOneOptions, getConnectionManager } from 'typeorm';
import { InvalidQueryResponseError } from '../../domain/errors/raw-query-builder/invalid-response.domain-error';
import { QueryNotLoadedError } from '../../domain/errors/raw-query-builder/query-not-loaded.domain-error';
import { omitNulls } from './omit.utils';
import { QueryAliasesMap } from '../persistence/query/query-aliases-map.type';

@Injectable()
export class RawQueryBuilder<F> {
  public buildQuery(
    rawQuery: string,
    tableAlias: string,
    options: Array<Partial<F>>,
    fieldsMap?: QueryAliasesMap,
  ): [query: string, parameters: any[]] {
    const filteredOptions: Array<FindOneOptions['where']> = options.map((o) =>
      omitNulls(o),
    );
    const { take, skip } = filteredOptions[0];

    if (take !== 'undefined') {
      delete filteredOptions[0].take;
    }
    if (skip !== 'undefined') {
      delete filteredOptions[0].skip;
    }

    let [query, parameters] = this.buildWhere(
      rawQuery,
      filteredOptions,
      tableAlias,
      fieldsMap,
    );

    if (query.includes('==PAGINATION==')) {
      query = this.buildPagination(query, parameters, take, skip);
    }

    return [query, parameters];
  }

  private buildPagination(
    query: string,
    parameters: any[],
    take: number,
    skip: number,
  ) {
    parameters.push(skip);
    parameters.push(take);
    return query.replace(
      new RegExp('==PAGINATION==', 'g'),
      `OFFSET @${parameters.length - 2} ROWS FETCH NEXT @${
        parameters.length - 1
      } ROWS ONLY`,
    );
  }

  private buildWhere(
    rawQuery: string,
    filteredOptions: FindOneOptions['where'],
    tableAlias: string,
    fieldsMap?: QueryAliasesMap,
  ): [query: string, parameters: []] {
    let parameters: [] = [];

    const whereClausuleGroup: Array<string[]> = filteredOptions.map((opt, groupIndex) => {
      const keysFromMap = fieldsMap?.get(groupIndex).map((entry) => entry[0]);

      return Object.entries(opt).map((e, index) => {
        const [key, value] = e;
        const formattedKey = key
          .split(/(?=[A-Z])/)
          .join('_')
          .toLowerCase();
        let aliasField = tableAlias;
        let nameField = formattedKey;

        if (keysFromMap?.includes(key)) {
          const keyValues = fieldsMap
            ?.get(groupIndex)
            .find((entry) => entry[0] === key);

          aliasField = keyValues[1]?.alias;
          nameField = keyValues[1]?.name;
        }

        return ` ${
          index > 0 ? 'AND ' : ''
        }${aliasField}.${nameField} ${this.buildValueComparison(
          value,
          parameters,
        )}`;
      });
    });

    whereClausuleGroup.forEach((clausule, index) => {
      const WHERE_STRING =
        whereClausuleGroup.length < 2 ? '==WHERE==' : `==WHERE<${index}>==`;

      const AND_WHERE_STRING =
        whereClausuleGroup.length < 2
          ? '==ANDWHERE=='
          : `==ANDWHERE<${index}>==`;

      rawQuery = rawQuery.replace(
        new RegExp(WHERE_STRING, 'g'),
        clausule.length > 0 ? 'WHERE'.concat(clausule.join(' ')) : '',
      );

      rawQuery = rawQuery.replace(
        new RegExp(AND_WHERE_STRING, 'g'),
        clausule.length > 0 ? 'AND'.concat(clausule.join(' ')) : '',
      );
    });

    return [rawQuery, parameters];
  }

  private buildValueComparison(value: any, parameters: any[]): string {
    if (Array.isArray(value)) {
      let arrayParameters = '';

      value.forEach((v) => {
        parameters.push(v);
        arrayParameters += `@${parameters.length - 1},`;
      });
      arrayParameters = arrayParameters.replace(/,\s*$/, '');
      return `IN (${arrayParameters})`.concat('\n');
    }

    parameters.push(value);

    return `= @${parameters.length - 1} `;
  }

  public async executeQueryArray<T>(
    rawQuery: string,
    tableAlias: string,
    options: Array<Partial<F>>,
    fieldsMap?: QueryAliasesMap,
  ): Promise<Array<T>> {
    return (await this.executeQueryCommon<T>(
      rawQuery,
      tableAlias,
      options,
      fieldsMap,
    )) as Array<T>;
  }

  public async executeQuery<T>(
    rawQuery: string,
    tableAlias: string,
    options: Array<Partial<F>>,
    fieldsMap?: QueryAliasesMap,
  ): Promise<T> {
    return (
      await this.executeQueryCommon<T>(rawQuery, tableAlias, options, fieldsMap)
    )[0] as T;
  }

  private async executeQueryCommon<T>(
    rawQuery: string,
    tableAlias: string,
    options: Array<Partial<F>>,
    fieldsMap?: QueryAliasesMap,
  ): Promise<any> {
    const [query, parameters] = this.buildQuery(
      rawQuery,
      tableAlias,
      options,
      fieldsMap,
    );
    if (query === '') {
      throw new QueryNotLoadedError();
    }
    const queryResponse: any = await getConnectionManager()
      .get()
      .query(query, parameters);

    if (queryResponse.length === 0 || this.validateResponse<T>(queryResponse)) {
      return queryResponse;
    }
  }

  private validateResponse<T>(queryResponse: unknown): boolean {
    const objectToCompare = queryResponse[0];
    const modelObjet = new Object({}) as T;
    const keys = Object.keys(modelObjet);
    const validateKeys = keys.reduce(
      (acc, el) => (objectToCompare[0].hasOwnProperty(el) ? 1 : 0),
      0,
    );
    if (validateKeys === keys.length) {
      return true;
    } else {
      throw new InvalidQueryResponseError();
    }
  }
}
